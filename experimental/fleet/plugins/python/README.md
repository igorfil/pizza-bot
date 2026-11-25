# Python plugin

Runs plain Python agents. Each folder in `agents/` (or `PYTHON_AGENTS_DIR`) is one agent, run once
per task as its own process. The plugin needs Python 3.11+; `plugin.toml` starts it with `uv`, which
fetches one if the machine's is older.

```
agents/<id>/
├── agent.toml     manifest (below)
└── agent.py       the agent; anything else it needs sits beside it
```

```toml
name = "Slow test agent"                  # shown in UIs
description = "Reports progress …"        # shown on agent cards
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
there is no virtualenv to manage; any other `agent.py` runs with the plugin's Python.

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

Test an agent alone: `cd agents/slow && echo '{"input":"steps=2 every=1 hi"}' | python3 agent.py`.

## The agents here

| id | Input | Does |
|---|---|---|
| `slow` | `steps=N every=S text` | N progress updates S seconds apart, then a result; no LLM. For mid-run and reconnect tests |

## Testing

```bash
python3 -m unittest discover -s experimental/fleet/plugins/python   # needs Python 3.11+
```
