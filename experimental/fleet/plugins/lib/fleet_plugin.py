"""Shared by the harness plugins in this folder: the runner protocol and one process per run.

A plugin imports this, says how to list its agents and how to start a run, and calls `serve`.
Protocol: plugins/README.md. Needs Python 3.11+."""

import json
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Iterable

KILL_GRACE_SECS = 5
STDERR_TAIL = 20

Event = dict
Translate = Callable[[str], Iterable[Event]]

_out = threading.Lock()


def send(message: dict) -> None:
    with _out:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def log(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def contract_event(line: str) -> list[Event]:
    """A line of the one-shot agent contract (plugins/python/README.md) as run events."""
    try:
        event = json.loads(line)
    except ValueError:
        return []
    if not isinstance(event, dict):
        return []
    if isinstance(event.get("status"), str):
        return [{"status": event["status"]}]
    if isinstance(event.get("error"), str):
        return [{"error": event["error"]}]
    artifact = event.get("artifact")
    if isinstance(artifact, dict):
        return [{"artifact": {"name": str(artifact.get("name", "result")), "text": str(artifact.get("text", ""))}}]
    return []


def failure(code: int, errored: bool, last_stderr: str | None) -> str | None:
    """Why a finished run failed, or None when it succeeded."""
    if errored or code == 0:
        return None
    return last_stderr or (f"exited with code {code}" if code > 0 else "killed by a signal")


def kill_group(proc: subprocess.Popen) -> None:
    """SIGTERM to the run's process group, SIGKILL if it's still there after the grace period."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=KILL_GRACE_SECS)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class Runs:
    """Live runs by task id: each is one process whose stdout lines become run events."""

    def __init__(self) -> None:
        self._procs: dict[str, subprocess.Popen] = {}
        self._stops: dict[str, Callable[[], None]] = {}
        self._canceled: set[str] = set()
        self._lock = threading.Lock()

    def start(
        self,
        task_id: str,
        command: str | list[str],
        *,
        cwd: str | os.PathLike | None = None,
        env: dict[str, str] | None = None,
        stdin: str = "",
        translate: Translate = contract_event,
        stop: Callable[[subprocess.Popen], None] = kill_group,
        label: str = "",
        on_exit: Callable[[int], None] | None = None,
    ) -> None:
        """Starts the process; on cancel, `stop` gets it (default: SIGTERM, then SIGKILL, to its process group)."""
        proc = subprocess.Popen(
            command,
            shell=isinstance(command, str),
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        with self._lock:
            self._procs[task_id] = proc
            self._stops[task_id] = lambda: stop(proc)
        proc.stdin.write(stdin)
        proc.stdin.close()
        threading.Thread(target=self._watch, args=(task_id, proc, translate, label, on_exit), daemon=True).start()

    def _watch(self, task_id: str, proc: subprocess.Popen, translate: Translate, label: str, on_exit: Callable[[int], None] | None) -> None:
        tail: list[str] = []

        def drain_stderr() -> None:
            for line in proc.stderr:
                line = line.rstrip("\n")
                log(f"[{label or task_id}] {line}")
                tail[:] = (tail + [line])[-STDERR_TAIL:]

        reader = threading.Thread(target=drain_stderr, daemon=True)
        reader.start()
        errored = False
        for line in proc.stdout:
            for event in translate(line):
                errored = errored or "error" in event
                send({"taskId": task_id, **event})
        code = proc.wait()
        reader.join(timeout=1)
        with self._lock:
            self._procs.pop(task_id, None)
            self._stops.pop(task_id, None)
            canceled = task_id in self._canceled
            self._canceled.discard(task_id)
        if on_exit and not canceled:
            on_exit(code)
        reason = None if canceled else failure(code, errored, tail[-1] if tail else None)
        if reason:
            send({"taskId": task_id, "error": reason})
        send({"taskId": task_id, "done": True})

    def cancel(self, params: dict) -> dict:
        task_id = params.get("taskId", "")
        with self._lock:
            stop = self._stops.get(task_id)
            if stop:
                self._canceled.add(task_id)
        if stop:
            threading.Thread(target=stop, daemon=True).start()
        return {}

    def stop_all(self) -> None:
        with self._lock:
            stops = list(self._stops.values())
        for stop in stops:
            stop()


Method = Callable[[dict], dict]


def handle(methods: dict[str, Method], line: str) -> None:
    try:
        request = json.loads(line)
    except ValueError:
        return
    if not isinstance(request, dict):
        return
    method = methods.get(request.get("method"))
    if method is None:
        send({"id": request.get("id"), "error": f"unknown method {request.get('method')!r}"})
        return
    try:
        send({"id": request.get("id"), "result": method(request.get("params") or {})})
    except Exception as e:  # noqa: BLE001 - every failure goes back to the runner as the request's error
        send({"id": request.get("id"), "error": str(e)})


def serve(methods: dict[str, Method], runs: Runs) -> None:
    """Answers the runner until its end of stdin closes, then stops every run."""
    for line in sys.stdin:
        handle(methods, line)
    runs.stop_all()


def agent_fields(agent: dict) -> dict:
    """What the runner gets about an agent from `agents`."""
    return {k: agent[k] for k in ("id", "name", "description", "input", "timeoutSecs") if agent.get(k) is not None}
