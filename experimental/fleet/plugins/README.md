# Harness plugins

A harness plugin runs **external** agents: agents the runner doesn't configure. The runner starts
the plugin, asks it what agents it has, gives it tasks, relays what it reports, and cancels runs.
The runner's MCP servers, skills and model settings never reach a plugin agent; it brings its own
tools. Built-in agents run on the runner's engine instead ([agents/README.md](../agents/README.md)).

| Plugin | Runs | Healthy when |
|---|---|---|
| [`python`](python/README.md) | plain Python agent folders, one process per run | always |
| [`docker`](docker/README.md) | container images, `docker run -i` per run | `docker version` reaches a daemon |
| [`claude-code`](claude-code/README.md) | Claude Code in a project folder, `claude -p` per run; follow-ups resume the session | `claude --version` works |
| [`agentcore`](agentcore/README.md) | runtimes deployed to Bedrock AgentCore, `InvokeAgentRuntime` per run | AWS credentials are there |

The AWS guide installs all of them; one that can't work on a machine (no Docker, no Claude Code)
shows as unavailable on the runner, with the reason.

The plugins here are TypeScript in one workspace package (`@pizza-bot/fleet-plugins`). Each is
bundled into `<plugin>/plugin.mjs` and runs on Node: on a deployed runner, the Node that ships with
the built-in engine, so a runner needs no other language for its plugins. A plugin implements the
`Harness` interface in [`src/protocol.ts`](src/protocol.ts) (`health`, `agents`, `prepare` a run)
and calls `serve`, which speaks the protocol below; [`src/process.ts`](src/process.ts) runs one
process per run and stops its process group on cancel.

A plugin doesn't have to be TypeScript: any program that speaks the protocol works.

## Folder

```
plugins/<id>/
├── plugin.toml    name, command, env
└── …              whatever the command needs
```

```toml
name = "Python"                                  # shown in UIs until the plugin describes itself
command = "node plugin.mjs"                      # run with `sh -c` in this folder, once, kept running
[env]                                            # optional extra environment
PYTHON_AGENTS_DIR = "/srv/agents"
```

The runner loads every folder in `RUNNER_PLUGINS_DIR` (default `plugins`; the AWS guide installs
this folder to `/opt/fleet-plugins`) at startup. A folder whose `plugin.toml` doesn't parse is
skipped with a warning.

## Protocol

The runner starts `command` once and keeps it running. Both sides write one JSON object per line:
the runner on the plugin's stdin, the plugin on its stdout. Anything on stdout that isn't one of the
lines below is ignored; stderr goes to the runner's log.

**Requests** from the runner carry an `id`; the plugin answers each with the same `id` and either a
`result` or an `error` string, in any order:

```json
{"id": 7, "method": "agents", "params": {}}
{"id": 7, "result": {"agents": [{"id": "slow", "name": "Slow test agent"}]}}
{"id": 8, "error": "there is no Python agent 'nope'"}
```

| Method | Params | Result |
|---|---|---|
| `describe` | none | `{name, version, capabilities: [...]}`; `cancel` is the one capability the runner reads today |
| `health` | none | `{ok, detail}`; shown on the runner in the Fleet page |
| `agents` | none | `{agents: [{id, name, description?, input?: {label, hint, example}, timeoutSecs?}]}` |
| `run` | `{taskId, contextId, agent, input}` | `{}` once the run started; an error if it can't start |
| `cancel` | `{taskId}` | `{}`; then the run ends with `done` |

**Run events** carry the task's `taskId` and no `id`:

| Line | Meaning |
|---|---|
| `{"taskId": "…", "status": "reading inbox"}` | progress; shows as the run's status text |
| `{"taskId": "…", "artifact": {"name": "brief", "text": "…"}}` | a result; same `name` again replaces it |
| `{"taskId": "…", "error": "Midway expired"}` | the run failed with this reason |
| `{"taskId": "…", "done": true}` | the run is over: `completed` unless it reported an error |

Every run ends with `done`, canceled ones too. The runner owns the timeout (`timeoutSecs`, default
600): it sends `cancel` and fails the run. Agent ids must be lowercase letters, digits, `-` or `_`;
an id another agent on the runner already has is ignored.

**Lifecycle.** The runner asks `describe`, `health` and `agents` at startup and every 30s, so agents
a plugin adds or drops show up without a restart. If the plugin exits, its runs fail with "the
`<id>` plugin stopped" and the next request starts it again. When the runner stops, the plugin's
stdin closes; the plugin should stop its runs and exit.

Plugin agents start out as `available`, like shipped agents: turn them on with Add agent → Turn on
existing, or list them in `RUNNER_AGENTS`.

## Testing

```bash
npm test -w @pizza-bot/fleet-plugins        # also part of npm test
npm run build -w @pizza-bot/fleet-plugins   # writes <plugin>/plugin.mjs; npm run build does it too
```
