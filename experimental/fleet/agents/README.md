# Agents

Each folder here is one **built-in** agent: it runs on the runner's own engine, Pizza Bot's agent
runtime (`apps/fleet-agent`). A runner scans this directory at startup and serves every agent it
finds as its own A2A endpoint (`/agents/<folder>/`). The runner owns A2A, auth, the durable task
store, cancel and health, and configures the agent: model, system prompt, skills, and picks from its
MCP servers.

External agents (Python scripts, containers, other runtimes) don't live here: harness plugins run
them and bring their own tools ([plugins/README.md](../plugins/README.md)). A folder here with a
`command` instead of the engine is skipped with a warning.

Agents are not part of the runner's source. Add one by adding a folder; no runner rebuild. A runner
may ship no agents at all (no `agents/` folder): agents are then created on the Fleet page.

## Folder

```
agents/<id>/
├── agent.toml     manifest (below)
├── system.md      the system prompt
├── skills/<id>/   optional skills (SKILL.md and its files)
└── .mcp.json      optional MCP servers of its own, Claude format
```

`<id>` is the folder name: lowercase, used in URLs and task ids.

## agent.toml

```toml
name = "Web research"                     # shown in UIs
description = "Reads web pages …"         # shown on agent cards
harness = "pizza-bot"                     # the built-in engine
timeout_secs = 300                        # optional, default 600; the run fails after this
mcp = ["fetch"]                           # optional; picks from the runner's MCP servers

[input]                                   # optional; how UIs label the input box
label = "Question"
hint = "a question, ideally with the URLs to read"
example = "What's on the Hacker News front page?"   # default input

[env]
MODEL = "us.anthropic.claude-haiku-5-5"   # a Bedrock id, or <provider>:<id>
```

MCP servers run on the runner's machine, so they belong to the runner: its library is one
Claude-format `mcp.json` beside the task store (`RUNNER_MCP_CONFIG`), managed over
`PUT`/`DELETE /mcp-servers/<id>`, and `mcp = [...]` picks from it. The runner passes the library and
the picks as `FLEET_MCP_CONFIG` and `FLEET_MCP_SERVERS`. A server that no skill grants gets a skill
of its own.

The runner has the engine when `RUNNER_HARNESS_PIZZA_BOT` holds the command that starts it; `npm run
dev` sets it for the laptop runner, and the AWS guide installs it to `/opt/fleet-engine`.

## How a run goes

The runner starts the engine once per task in the agent's folder (`sh -c`, its own process group),
with the runner's environment plus `[env]`, `FLEET_TASK_ID` and the MCP variables above. It writes
`{"taskId": "…", "contextId": "…", "input": "…"}` on stdin; the engine answers with JSON lines on
stdout (`{"status": …}`, `{"artifact": {"name": …, "text": …}}`, `{"error": …}`) and exits 0 when it
succeeded. A follow-up from the Fleet page is a new task with the earlier run's `contextId`; the
engine keeps each context's conversation under `.state/` in the folder (or `FLEET_AGENT_STATE`), so
it answers with what was said before. Cancel and timeout send SIGTERM to the process group, SIGKILL
5s later. stderr goes to the runner's log.

## The agents here

| id | Input | Uses |
|---|---|---|
| `webresearch` | question | its own fetch MCP (`.mcp.json`, `uvx mcp-server-fetch`), Bedrock Haiku 5.5 |

Which agents a runner serves (its enabled agents) starts from `RUNNER_AGENTS` (comma list of ids,
including plugin agents; default: all). Enable and Disable on the Fleet page change it through the
runner's `PUT /agents`, which is saved and wins from then on.

## Created agents

Add agent → Create new on the Fleet page makes the bare-minimum agent: a name, a Bedrock model and a
system prompt, plus the runner's MCP servers and skills from Pizza Bot's skill library. It runs on
the built-in engine; a runner without the engine has `canCreate` false and refuses to create agents.
The agent holds a copy of each skill under `skills/<id>/`; an edit that keeps a skill sends only its
id, so the copy stays as it was until the skill is picked again. The runner writes it as an ordinary
agent folder in `RUNNER_CREATED_AGENTS_DIR` (`agent.toml` with `MODEL` in `[env]`, `system.md`,
`skills/`). Created agents from before the engine ran a single-call `agent.py`; the runner moves them
to the engine on start. Deleting a created agent deletes its folder. Any agent can be disabled and
enabled again; a disabled one keeps its schedule and runs but doesn't run. A shipped agent can only
be disabled. The runner's AWS credentials (on EC2, the instance role) must allow the
model.
