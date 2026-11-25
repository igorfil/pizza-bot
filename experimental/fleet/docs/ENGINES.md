# Engines and harness plugins: plan

The runner is an orchestrator and observer. It runs its **own agents** on one built-in engine, and
everything else through **harness plugins** it only starts, watches and cancels.

| | Built-in agents (Pizza Bot engine) | Plugin agents (Python, Docker, Claude Code, AgentCore, …) |
|---|---|---|
| Configured by | the runner: model, prompt, skills, MCP servers, secrets | the harness itself |
| Runner's MCP servers | yes, agents pick from the runner's library | never; they use whatever they already have |
| Runner's job | runs them in full | start a task, relay status and results, cancel |
| Create / edit in the UI | full form | only what the plugin offers |

Deploys stay simple for now: remote runners get what `npm run build` made on this machine, copied
over SSM (see POC-GAPS.md, "Deploy simplified").

## Step 1: the built-in engine on every runner
- `deploy/dev-build.sh` packs `fleet-engine-<arch>.tar.gz`: a pinned Linux Node 24, the
  `apps/fleet-agent` bundle (main.js, eval worker, wasm) and `better-sqlite3` with only its Linux
  prebuild (N-API, so it doesn't depend on the Node version).
- `deploy/dev-push.sh` copies it with the runner; the install script unpacks it to
  `/opt/fleet-engine` and points the runner at it.
- Created agents always run on the engine. The single-call `prompt_agent.py` fallback goes; created
  agents still on it move to the engine on startup. A runner without the engine can't create agents.
- Test: unit tests, plus the Linux engine tarball run in a Linux container like the instance would.

## Step 2: built-in vs external, and no shipped Python agents
- Every agent reports a `kind`: `builtin` or external. The runner hands MCP servers, skills and the
  model only to built-in agents; an external manifest can't name the runner's MCP servers.
- The UI follows the split: the runner's MCP tab says its servers are for built-in agents; plugin
  agents' Settings and MCP tabs say the harness manages them.
- Remove the shipped Python agents (`dadjokes`, `geofact`, `morningbrief`, `slow`, `sysreport`) and
  the agents tarball; `webresearch` stays as the shipped built-in example. A runner may have no
  `agents/` folder at all.

## Step 3: the harness plugin interface
- A plugin is a folder `plugins/<name>/plugin.toml` naming a long-lived program. The runner talks
  to it over JSON lines on stdin/stdout, so plugins can be in any language.
- Calls: `describe` (name, version, capabilities), `health`, `agents`, `run` (streams status,
  artifacts, error, done per task id), `cancel`.
- The runner keeps the A2A endpoints, auth, task store, timeouts, logs and schedules for every agent.
- First plugin: **Python** (plain agent folders with the old stdin/stdout contract). The runner's
  own run-a-command path moves into it.
- Then **Docker** (`docker run -i`, `docker kill` on cancel), **Claude Code** (`claude -p` in a
  project folder, `--resume` for follow-ups) and **AgentCore** (`InvokeAgentRuntime`, one runtime
  session per conversation, `StopRuntimeSession` on cancel), one at a time.

## Not done yet
- AgentCore was tested against the SDK's types and one real call, not a deployed runtime.
- The release workflow doesn't publish the engine or plugins yet; deploys copy this machine's build.
- Built-in agents still start one engine process per run (about 1s on an EC2-sized Linux box).

## Status
- [x] Step 1
- [x] Step 2
- [x] Step 3: interface + Python plugin
- [x] Step 3: Docker plugin
- [x] Step 3: Claude Code plugin
- [x] Step 3: AgentCore plugin
