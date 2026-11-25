# /// script
# requires-python = ">=3.11"
# ///
"""Harness plugin for container agents: each agent is an image, run with `docker run -i` once per task.

The container speaks the one-shot agent contract (plugins/python/README.md) on its stdin and stdout;
cancel kills the container. Agents are `agents/<id>/agent.toml` (README.md)."""

import json
import os
import re
import shlex
import subprocess
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from fleet_plugin import Runs, agent_fields, log, serve  # noqa: E402

VERSION = "1"
HEALTH_TIMEOUT_SECS = 10

AGENTS_DIR = Path(os.environ.get("DOCKER_AGENTS_DIR", Path(__file__).parent / "agents"))
DOCKER = shlex.split(os.environ.get("DOCKER", "docker"))

runs = Runs()


def load_agent(folder: Path) -> dict | None:
    try:
        manifest = tomllib.loads((folder / "agent.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        log(f"skipping {folder.name}: {e}")
        return None
    if not isinstance(manifest.get("image"), str) or not manifest["image"]:
        log(f"skipping {folder.name}: agent.toml needs an image")
        return None
    return {
        "id": folder.name,
        "name": manifest.get("name", folder.name),
        "description": manifest.get("description", ""),
        "input": manifest.get("input"),
        "timeoutSecs": manifest.get("timeout_secs"),
        "image": manifest["image"],
        "command": [str(a) for a in manifest.get("command", [])],
        "args": [str(a) for a in manifest.get("args", [])],
        "env": {k: str(v) for k, v in manifest.get("env", {}).items()},
    }


def agents() -> dict[str, dict]:
    if not AGENTS_DIR.is_dir():
        return {}
    found = (load_agent(p) for p in sorted(AGENTS_DIR.iterdir()) if (p / "agent.toml").is_file())
    return {a["id"]: a for a in found if a}


def container_name(task_id: str) -> str:
    """A name docker accepts, unique per run, so cancel can find the container."""
    return "fleet-" + re.sub(r"[^a-zA-Z0-9_.-]", "-", task_id)


def run_command(agent: dict, task_id: str) -> list[str]:
    env = [arg for k, v in {**agent["env"], "FLEET_TASK_ID": task_id}.items() for arg in ("--env", f"{k}={v}")]
    return [*DOCKER, "run", "--rm", "-i", "--init", "--name", container_name(task_id), *env, *agent["args"], agent["image"], *agent["command"]]


def kill(task_id: str) -> None:
    subprocess.run([*DOCKER, "kill", container_name(task_id)], capture_output=True, check=False)


def run(params: dict) -> dict:
    agent = agents().get(params.get("agent", ""))
    if not agent:
        raise ValueError(f"there is no Docker agent {params.get('agent')!r}")
    task_id = params["taskId"]
    runs.start(
        task_id,
        run_command(agent, task_id),
        stdin=json.dumps({"taskId": task_id, "contextId": params.get("contextId"), "input": params.get("input", "")}),
        stop=lambda _proc: kill(task_id),
        label=agent["id"],
    )
    return {}


def health(_: dict) -> dict:
    try:
        version = subprocess.run([*DOCKER, "version", "--format", "{{.Server.Version}}"], capture_output=True, text=True, timeout=HEALTH_TIMEOUT_SECS)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "detail": f"docker isn't usable: {e}"}
    if version.returncode != 0:
        why = (version.stderr.strip().splitlines() or ["the daemon didn't answer"])[-1]
        return {"ok": False, "detail": f"docker isn't usable: {why}"}
    count = len(agents())
    return {"ok": True, "detail": f"Docker {version.stdout.strip()}, {count} agent{'' if count == 1 else 's'}"}


METHODS = {
    "describe": lambda _: {"name": "Docker", "version": VERSION, "capabilities": ["cancel"]},
    "health": health,
    "agents": lambda _: {"agents": [agent_fields(a) for a in agents().values()]},
    "run": run,
    "cancel": runs.cancel,
}


if __name__ == "__main__":
    serve(METHODS, runs)
