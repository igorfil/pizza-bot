# Agents

Each folder here is one agent. A runner scans this directory at startup and serves every agent it
finds as its own A2A endpoint (`/agents/<folder>/`). The runner owns A2A, auth, the durable task
store, cancel and health; an agent is just a program that turns one input into results.

Agents are not part of the runner's source. Add one by adding a folder; no runner rebuild.

## Folder

```
agents/<id>/
├── agent.toml     manifest (below)
└── …              whatever the command needs (agent.py, scripts, a Dockerfile…)
```

`<id>` is the folder name: lowercase, used in URLs and task ids.

## agent.toml

```toml
name = "Dad jokes"                        # shown in UIs
description = "Writes 5 dad jokes …"      # shown on agent cards
command = "uv run --quiet agent.py"       # run with `sh -c` in this folder, once per task
timeout_secs = 120                        # optional, default 600; the run fails after this

[input]                                   # optional; how UIs label the input box
label = "Topic"
hint = "what the jokes should be about"
example = "kubernetes"                    # default input

[env]                                     # optional extra environment for the command
MODEL = "us.openai.gpt-6.1-terra"
```

Instead of `command`, an agent can name a `harness` the runner provides. `harness = "pizza-bot"` runs
the folder on pizza-bot's agent runtime (`apps/fleet-agent`): `system.md` is the system prompt,
`MODEL` in `[env]` the model (a Bedrock id, or `<provider>:<id>`), `.mcp.json` (Claude format) the MCP
servers and `skills/<id>/SKILL.md` the skills. A server that no skill grants gets a skill of its own.
The runner offers a harness when `RUNNER_HARNESS_<NAME>` holds the command that starts it;
`npm run dev` sets `RUNNER_HARNESS_PIZZA_BOT` for the laptop runner. See `agents/webresearch`.

## The run contract

1. **Start.** The runner runs `command` via `sh -c` with this folder as the working directory, in
   its own process group. Environment: the runner's own (so `PATH`, AWS credentials, `HOME`), plus
   `[env]`, plus `FLEET_TASK_ID`.
2. **Input.** One JSON object on stdin, then stdin closes:
   ```json
   {"taskId": "…", "contextId": "…", "input": "kubernetes"}
   ```
   A follow-up from the Fleet page is a new task with the earlier run's `contextId`. The `pizza-bot`
   harness keeps each context's conversation under `.state/` in the folder (or `FLEET_AGENT_STATE`),
   so it answers with what was said before; an agent that keeps nothing just sees a new input.
3. **Events.** One JSON object per line on stdout. Anything that isn't a JSON object is ignored.
   | Line | Meaning |
   |---|---|
   | `{"status": "reading inbox"}` | progress; shows as the run's status text |
   | `{"artifact": {"name": "jokes", "text": "…"}}` | a result; same `name` again replaces it |
   | `{"error": "Midway expired, run mwinit"}` | the run failed with this reason |
4. **End.** Exit code 0 and no `error` event → `completed` (status text = last `status`). Otherwise
   `failed`, with the `error` event, or else the last stderr line, or else the exit code as the reason.
5. **Logs.** stderr goes to the runner's log. Use it freely.
6. **Cancel.** SIGTERM to the process group, SIGKILL 5s later. Timeout does the same and fails the run.

Test an agent without a runner:

```bash
cd agents/dadjokes && echo '{"input":"tacos"}' | uv run --quiet agent.py
```

## Python agents

Single files with inline dependencies ([PEP 723](https://peps.python.org/pep-0723/)), run with
`uv run`, so there is no virtualenv to manage:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
```

## Docker

A container is just another command, e.g.
`command = "docker run --rm -i -e AWS_REGION my-agent:latest"`. `-i` keeps stdin open for the
input; stdout and exit code carry the contract unchanged.

## The agents here

| id | Runs on | Input | Uses |
|---|---|---|---|
| `dadjokes` | EC2 | topic | Bedrock `us.openai.gpt-6.1-terra` |
| `geofact` | EC2 | optional place | Bedrock `us.amazon.nova-micro-v1:0` |
| `sysreport` | laptop | optional focus | `sysinfo.sh` + Bedrock Haiku 5.5 |
| `morningbrief` | laptop | optional focus | Outlook MCP (`aws-outlook-mcp`, read-only) + Bedrock Haiku 5.5 |
| `slow` | laptop | `steps=N every=S text` | nothing; for disconnect tests |
| `webresearch` | laptop | question | `pizza-bot` harness, fetch MCP (`uvx mcp-server-fetch`), Bedrock Haiku 5.5 |

Which agents a runner serves starts from `RUNNER_AGENTS` (comma list of ids; default: all folders).
Add agent on the Fleet page changes it through the runner's `PUT /agents`, which is saved and wins
from then on.

## Created agents

Add agent → Create new on the Fleet page makes the bare-minimum agent: a name, a Bedrock model and a
system prompt. On a runner with the `pizza-bot` harness it is written as `harness = "pizza-bot"`, and
the dialog also takes MCP servers and skills, which the runner writes as the folder's `.mcp.json` and
`skills/<name>/SKILL.md` (and returns in `GET /agents`, so they can be edited). Otherwise it runs the single-call script below. The runner writes it as an ordinary agent folder in `RUNNER_CREATED_AGENTS_DIR`
(`agent.toml` with `MODEL` in `[env]`, `system.md`, and `agent.py`, a copy of the harness built into
the runner from `runner/src/prompt_agent.py`). Each run sends the input to the model with the system
prompt through Bedrock Converse and returns the reply as a `reply` artifact; an empty input is sent
as "Go.", so agents that need no input just run. There are no tools and no memory between runs. The
runner rewrites every created agent's `agent.py` from its built-in copy on start, so harness fixes
reach existing agents. Deleting a created agent (trash icon on its card) deletes its folder; a
shipped agent is only turned off and can be added back. The runner's AWS credentials (on EC2, the instance role) must allow the model.
