# /// script
# requires-python = ">=3.11"
# ///
"""Harness plugin for Claude Code: each agent is a project folder, run with `claude -p` once per task.

A follow-up (same contextId) resumes the earlier Claude Code session, so it remembers the
conversation. Claude Code brings its own tools, MCP servers and login. Agents: README.md."""

import json
import os
import shlex
import subprocess
import sys
import threading
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from fleet_plugin import Runs, agent_fields, log, serve  # noqa: E402

VERSION = "1"
HEALTH_TIMEOUT_SECS = 20
# `claude -p` needs a prompt; agents meant to run without input still get one.
NO_INPUT = "Go."
STATUS_CHARS = 120

AGENTS_DIR = Path(os.environ.get("CLAUDE_CODE_AGENTS_DIR", Path(__file__).parent / "agents"))
# In the home folder: on EC2 the plugin folder belongs to root, and the runner's user can't write there.
STATE_FILE = Path(os.environ.get("CLAUDE_CODE_STATE", Path.home() / ".local" / "state" / "fleet-claude-code" / "sessions.json"))
CLAUDE = shlex.split(os.environ.get("CLAUDE", "claude"))

runs = Runs()
_sessions_lock = threading.Lock()


def load_agent(folder: Path) -> dict | None:
    try:
        manifest = tomllib.loads((folder / "agent.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        log(f"skipping {folder.name}: {e}")
        return None
    project = Path(manifest.get("project", ".")).expanduser()
    return {
        "id": folder.name,
        "name": manifest.get("name", folder.name),
        "description": manifest.get("description", ""),
        "input": manifest.get("input"),
        "timeoutSecs": manifest.get("timeout_secs"),
        "project": project if project.is_absolute() else (folder / project).resolve(),
        "model": manifest.get("model"),
        "allowed_tools": [str(t) for t in manifest.get("allowed_tools", [])],
        "permission_mode": manifest.get("permission_mode"),
        "system_prompt": manifest.get("system_prompt"),
        "max_turns": manifest.get("max_turns"),
        "env": {k: str(v) for k, v in manifest.get("env", {}).items()},
    }


def agents() -> dict[str, dict]:
    if not AGENTS_DIR.is_dir():
        return {}
    found = (load_agent(p) for p in sorted(AGENTS_DIR.iterdir()) if (p / "agent.toml").is_file())
    return {a["id"]: a for a in found if a}


def sessions() -> dict[str, str]:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remember_session(key: str, session_id: str) -> None:
    with _sessions_lock:
        known = sessions()
        if known.get(key) == session_id:
            return
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({**known, key: session_id}), encoding="utf-8")
        tmp.replace(STATE_FILE)


def claude_command(agent: dict, prompt: str, resume: str | None) -> list[str]:
    flags = [
        *(["--model", agent["model"]] if agent["model"] else []),
        *(["--allowedTools", ",".join(agent["allowed_tools"])] if agent["allowed_tools"] else []),
        *(["--permission-mode", agent["permission_mode"]] if agent["permission_mode"] else []),
        *(["--append-system-prompt", agent["system_prompt"]] if agent["system_prompt"] else []),
        *(["--max-turns", str(agent["max_turns"])] if agent["max_turns"] else []),
        *(["--resume", resume] if resume else []),
    ]
    return [*CLAUDE, "-p", prompt or NO_INPUT, "--output-format", "stream-json", "--verbose", *flags]


def short(text: str) -> str:
    line = text.strip().splitlines()[0] if text.strip() else ""
    return line if len(line) <= STATUS_CHARS else line[: STATUS_CHARS - 1] + "…"


def translate(line: str, on_session=lambda _: None) -> list[dict]:
    """A line of `claude -p --output-format stream-json` as run events."""
    try:
        message = json.loads(line)
    except ValueError:
        return []
    if not isinstance(message, dict):
        return []
    if isinstance(message.get("session_id"), str):
        on_session(message["session_id"])
    kind = message.get("type")
    if kind == "system" and message.get("subtype") == "init":
        return [{"status": f"Claude Code started ({message.get('model', 'default model')})"}]
    if kind == "assistant":
        content = (message.get("message") or {}).get("content") or []
        tools = [c.get("name", "a tool") for c in content if isinstance(c, dict) and c.get("type") == "tool_use"]
        texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text" and c.get("text", "").strip()]
        if tools:
            return [{"status": f"using {', '.join(tools)}"}]
        return [{"status": short(texts[-1])}] if texts else []
    if kind == "result":
        result = message.get("result") if isinstance(message.get("result"), str) else ""
        if message.get("is_error") or message.get("subtype") != "success":
            return [{"error": result or f"Claude Code stopped: {message.get('subtype', 'error')}"}]
        return [{"artifact": {"name": "reply", "text": result}}, {"status": "answered"}]
    return []


def run(params: dict) -> dict:
    agent = agents().get(params.get("agent", ""))
    if not agent:
        raise ValueError(f"there is no Claude Code agent {params.get('agent')!r}")
    if not agent["project"].is_dir():
        raise ValueError(f"{agent['id']}'s project folder {agent['project']} doesn't exist")
    task_id = params["taskId"]
    key = f"{agent['id']}/{params.get('contextId') or task_id}"
    command = claude_command(agent, params.get("input", ""), sessions().get(key))
    runs.start(
        task_id,
        command,
        cwd=agent["project"],
        env={**os.environ, **agent["env"], "FLEET_TASK_ID": task_id},
        translate=lambda line: translate(line, lambda session_id: remember_session(key, session_id)),
        label=agent["id"],
    )
    return {}


def health(_: dict) -> dict:
    try:
        version = subprocess.run([*CLAUDE, "--version"], capture_output=True, text=True, timeout=HEALTH_TIMEOUT_SECS)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "detail": f"claude isn't usable: {e}"}
    if version.returncode != 0:
        return {"ok": False, "detail": f"claude isn't usable: {(version.stderr.strip().splitlines() or ['no output'])[-1]}"}
    count = len(agents())
    return {"ok": True, "detail": f"{version.stdout.strip()}, {count} agent{'' if count == 1 else 's'}"}


METHODS = {
    "describe": lambda _: {"name": "Claude Code", "version": VERSION, "capabilities": ["cancel", "conversations"]},
    "health": health,
    "agents": lambda _: {"agents": [agent_fields(a) for a in agents().values()]},
    "run": run,
    "cancel": runs.cancel,
}


if __name__ == "__main__":
    serve(METHODS, runs)
