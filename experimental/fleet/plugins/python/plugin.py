# /// script
# requires-python = ">=3.11"
# ///
"""Harness plugin for plain Python agents: each folder in agents/ is one agent, run once per task.

The runner talks to this process over JSON lines (plugins/README.md); each agent speaks the
one-shot contract: one JSON input on stdin, status/artifact/error lines on stdout, exit code."""

import json
import os
import shlex
import signal
import subprocess
import sys
import threading
import tomllib
from pathlib import Path

VERSION = "1"
KILL_GRACE_SECS = 5
STDERR_TAIL = 20

AGENTS_DIR = Path(os.environ.get("PYTHON_AGENTS_DIR", Path(__file__).parent / "agents"))

_out = threading.Lock()
_runs: dict[str, subprocess.Popen] = {}
_canceled: set[str] = set()
_runs_lock = threading.Lock()


def send(message: dict) -> None:
    with _out:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def log(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


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


def public(agent: dict) -> dict:
    return {k: agent[k] for k in ("id", "name", "description", "input", "timeoutSecs") if agent[k] is not None}


def contract_event(line: str) -> dict | None:
    """The agent's stdout line as a run event, or None when it isn't one."""
    try:
        event = json.loads(line)
    except ValueError:
        return None
    if not isinstance(event, dict):
        return None
    if isinstance(event.get("status"), str):
        return {"status": event["status"]}
    if isinstance(event.get("error"), str):
        return {"error": event["error"]}
    artifact = event.get("artifact")
    if isinstance(artifact, dict):
        return {"artifact": {"name": str(artifact.get("name", "result")), "text": str(artifact.get("text", ""))}}
    return None


def failure(code: int, errored: bool, last_stderr: str | None) -> str | None:
    """Why a finished run failed, or None when it succeeded."""
    if errored or code == 0:
        return None
    return last_stderr or (f"exited with code {code}" if code > 0 else "killed by a signal")


def watch(task_id: str, proc: subprocess.Popen, agent_id: str) -> None:
    tail: list[str] = []

    def drain_stderr() -> None:
        for line in proc.stderr:
            line = line.rstrip("\n")
            log(f"[{agent_id}] {line}")
            tail[:] = (tail + [line])[-STDERR_TAIL:]

    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()
    errored = False
    for line in proc.stdout:
        event = contract_event(line)
        if event:
            errored = errored or "error" in event
            send({"taskId": task_id, **event})
    code = proc.wait()
    reader.join(timeout=1)
    with _runs_lock:
        _runs.pop(task_id, None)
        canceled = task_id in _canceled
        _canceled.discard(task_id)
    reason = None if canceled else failure(code, errored, tail[-1] if tail else None)
    if reason:
        send({"taskId": task_id, "error": reason})
    send({"taskId": task_id, "done": True})


def run(params: dict) -> dict:
    agent = agents().get(params.get("agent", ""))
    if not agent:
        raise ValueError(f"there is no Python agent {params.get('agent')!r}")
    task_id = params["taskId"]
    env = {**os.environ, **agent["env"], "FLEET_TASK_ID": task_id}
    proc = subprocess.Popen(
        agent["command"],
        shell=True,
        cwd=agent["dir"],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    with _runs_lock:
        _runs[task_id] = proc
    proc.stdin.write(json.dumps({"taskId": task_id, "contextId": params.get("contextId"), "input": params.get("input", "")}))
    proc.stdin.close()
    threading.Thread(target=watch, args=(task_id, proc, agent["id"]), daemon=True).start()
    return {}


def stop(proc: subprocess.Popen) -> None:
    """SIGTERM to the run's process group, SIGKILL if it's still there after the grace period."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=KILL_GRACE_SECS)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def cancel(params: dict) -> dict:
    task_id = params.get("taskId", "")
    with _runs_lock:
        proc = _runs.get(task_id)
        if proc:
            _canceled.add(task_id)
    if proc:
        threading.Thread(target=stop, args=(proc,), daemon=True).start()
    return {}


def health(_: dict) -> dict:
    count = len(agents())
    return {"ok": True, "detail": f"{count} agent{'' if count == 1 else 's'} in {AGENTS_DIR}"}


METHODS = {
    "describe": lambda _: {"name": "Python", "version": VERSION, "capabilities": ["cancel"]},
    "health": health,
    "agents": lambda _: {"agents": [public(a) for a in agents().values()]},
    "run": run,
    "cancel": cancel,
}


def handle(line: str) -> None:
    try:
        request = json.loads(line)
    except ValueError:
        return
    method = METHODS.get(request.get("method"))
    if method is None:
        send({"id": request.get("id"), "error": f"unknown method {request.get('method')!r}"})
        return
    try:
        send({"id": request.get("id"), "result": method(request.get("params") or {})})
    except Exception as e:  # noqa: BLE001 - every failure goes back to the runner as the request's error
        send({"id": request.get("id"), "error": str(e)})


def main() -> None:
    for line in sys.stdin:
        handle(line)
    with _runs_lock:
        running = list(_runs.values())
    for proc in running:
        stop(proc)


if __name__ == "__main__":
    main()
