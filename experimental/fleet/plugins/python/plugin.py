# /// script
# requires-python = ">=3.11"
# ///
"""Harness plugin for plain Python agents: each folder in agents/ is one agent, run once per task.

Each agent speaks the one-shot contract (README.md): one JSON input on stdin, status/artifact/error
lines on stdout, exit code."""

import json
import os
import shlex
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from fleet_plugin import Runs, agent_fields, log, serve  # noqa: E402

VERSION = "1"

AGENTS_DIR = Path(os.environ.get("PYTHON_AGENTS_DIR", Path(__file__).parent / "agents"))

runs = Runs()


def default_command(folder: Path) -> str:
    script = folder / "agent.py"
    inline_deps = script.is_file() and "# /// script" in script.read_text(encoding="utf-8", errors="replace")
    return "uv run --quiet agent.py" if inline_deps else f"{shlex.quote(sys.executable)} agent.py"


def load_agent(folder: Path) -> dict | None:
    try:
        manifest = tomllib.loads((folder / "agent.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        log(f"skipping {folder.name}: {e}")
        return None
    return {
        "id": folder.name,
        "name": manifest.get("name", folder.name),
        "description": manifest.get("description", ""),
        "input": manifest.get("input"),
        "timeoutSecs": manifest.get("timeout_secs"),
        "command": manifest.get("command") or default_command(folder),
        "env": {k: str(v) for k, v in manifest.get("env", {}).items()},
        "dir": folder,
    }


def agents() -> dict[str, dict]:
    if not AGENTS_DIR.is_dir():
        return {}
    found = (load_agent(p) for p in sorted(AGENTS_DIR.iterdir()) if (p / "agent.toml").is_file())
    return {a["id"]: a for a in found if a}


def run(params: dict) -> dict:
    agent = agents().get(params.get("agent", ""))
    if not agent:
        raise ValueError(f"there is no Python agent {params.get('agent')!r}")
    task_id = params["taskId"]
    runs.start(
        task_id,
        agent["command"],
        cwd=agent["dir"],
        env={**os.environ, **agent["env"], "FLEET_TASK_ID": task_id},
        stdin=json.dumps({"taskId": task_id, "contextId": params.get("contextId"), "input": params.get("input", "")}),
        label=agent["id"],
    )
    return {}


def health(_: dict) -> dict:
    count = len(agents())
    return {"ok": True, "detail": f"{count} agent{'' if count == 1 else 's'} in {AGENTS_DIR}"}


METHODS = {
    "describe": lambda _: {"name": "Python", "version": VERSION, "capabilities": ["cancel"]},
    "health": health,
    "agents": lambda _: {"agents": [agent_fields(a) for a in agents().values()]},
    "run": run,
    "cancel": runs.cancel,
}


if __name__ == "__main__":
    serve(METHODS, runs)
