# Python plugin

Runs plain Python agents: a folder with an `agent.py`, run once per task as its own process. The
plugin itself is TypeScript on Node ([`src/python.ts`](../src/python.ts)); only the agents need
Python. Each agent is added on the Fleet page (Add agent → Add existing → Python), which keeps it as
an `agent.toml` in the plugin's data folder (`$FLEET_PLUGIN_DATA/agents/<id>/`); its `path` is the
agent's folder on the runner's machine:

```toml
name = "Slow test agent"                  # shown in UIs
description = "Reports progress …"        # shown on agent cards
path = "/srv/agents/slow"                 # the folder with agent.py
command = "python3 agent.py"              # optional; see below
timeout_secs = 3600                       # optional, default 600

[input]                                   # optional; how UIs label the input box
label = "Plan"
hint = "steps=N every=S <text>"
example = "steps=10 every=3 hello"        # default input

[env]                                     # optional extra environment
MODEL = "us.anthropic.claude-haiku-5-5"
```

Without `command`, an `agent.py` with inline dependencies
([PEP 723](https://peps.python.org/pep-0723/), `# /// script`) runs with `uv run --quiet agent.py`, so
there is no virtualenv to manage (the machine then needs `uv`); any other `agent.py` runs with
`python3`.

## The agent contract

1. **Start.** `command` runs via `sh -c` in the agent's folder, in its own process group, with the
   plugin's environment (so `PATH`, AWS credentials) plus `[env]` and `FLEET_TASK_ID`.
2. **Input.** One JSON object on stdin, then stdin closes: `{"taskId": "…", "contextId": "…", "input": "…"}`.
3. **Events.** One JSON object per line on stdout; anything else is ignored:
   `{"status": "…"}` (progress), `{"artifact": {"name": "…", "text": "…"}}` (a result; same name
   replaces it), `{"error": "…"}` (the run failed with this reason).
4. **End.** Exit code 0 and no `error` → completed. Otherwise failed, with the `error`, or else the
   last stderr line, or else the exit code.
5. **Logs.** stderr goes to the runner's log.
6. **Cancel.** SIGTERM to the process group, SIGKILL 5s later.

Test an agent alone: `cd experimental/fleet/test-agents/slow && echo '{"input":"steps=2 every=1 hi"}' | python3 agent.py`.
That slow test agent is one [test-agents/add.mjs](../../test-agents/README.md) adds.

## Testing

```bash
npm test -w @pizza-bot/fleet-plugins
```
