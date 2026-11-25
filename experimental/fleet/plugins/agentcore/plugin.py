# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.40"]
# ///
"""Harness plugin for Amazon Bedrock AgentCore Runtime: each agent is a deployed runtime, invoked once per task.

A run is a child process of this plugin that calls InvokeAgentRuntime and turns the reply into run
events. A conversation (contextId) maps to one runtime session, so follow-ups reach the same session.
Cancel stops the session. Agents: README.md."""

import hashlib
import json
import os
import subprocess
import sys
import tomllib
from collections.abc import Iterable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from fleet_plugin import Runs, agent_fields, kill_group, log, serve  # noqa: E402

VERSION = "1"
DEFAULT_QUALIFIER = "DEFAULT"
TEXT_KEYS = ("result", "response", "output", "text", "message", "content")

AGENTS_DIR = Path(os.environ.get("AGENTCORE_AGENTS_DIR", Path(__file__).parent / "agents"))

runs = Runs()


def region_of(arn: str) -> str | None:
    """arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>"""
    parts = arn.split(":")
    return parts[3] if len(parts) > 5 and parts[2] == "bedrock-agentcore" and parts[3] else None


def load_agent(folder: Path) -> dict | None:
    try:
        manifest = tomllib.loads((folder / "agent.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        log(f"skipping {folder.name}: {e}")
        return None
    arn = manifest.get("runtime_arn")
    if not isinstance(arn, str) or not region_of(arn):
        log(f"skipping {folder.name}: agent.toml needs runtime_arn, an AgentCore Runtime ARN")
        return None
    return {
        "id": folder.name,
        "name": manifest.get("name", folder.name),
        "description": manifest.get("description", ""),
        "input": manifest.get("input"),
        "timeoutSecs": manifest.get("timeout_secs"),
        "arn": arn,
        "qualifier": manifest.get("qualifier", DEFAULT_QUALIFIER),
        "region": manifest.get("region") or region_of(arn),
        "payload_key": manifest.get("payload_key", "prompt"),
    }


def agents() -> dict[str, dict]:
    if not AGENTS_DIR.is_dir():
        return {}
    found = (load_agent(p) for p in sorted(AGENTS_DIR.iterdir()) if (p / "agent.toml").is_file())
    return {a["id"]: a for a in found if a}


def session_id(agent_id: str, context_id: str) -> str:
    """One runtime session per conversation; AgentCore wants at least 33 characters."""
    return "fleet-" + hashlib.sha256(f"{agent_id}/{context_id}".encode()).hexdigest()[:40]


def reply_text(value: object) -> str:
    """The answer in a JSON reply: a string, a common text field, or the JSON itself."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        found = next((value[k] for k in TEXT_KEYS if isinstance(value.get(k), str)), None)
        if found is not None:
            return found
    return json.dumps(value)


def stream_events(lines: Iterable[str]) -> Iterable[dict]:
    """Server-sent events from a streaming runtime: contract events pass through, other data is the reply text."""
    text: list[str] = []
    for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        try:
            value = json.loads(data)
        except ValueError:
            value = data
        if isinstance(value, dict) and any(k in value for k in ("status", "artifact", "error")):
            yield value
        else:
            text.append(reply_text(value))
    if text:
        yield {"artifact": {"name": "reply", "text": "".join(text)}}


def relay(response: dict) -> Iterable[dict]:
    """Run events from an InvokeAgentRuntime response."""
    body = response["response"]
    if "text/event-stream" in response.get("contentType", ""):
        yield from stream_events(line.decode("utf-8") for line in body.iter_lines() if line)
        return
    raw = b"".join(body).decode("utf-8") if not hasattr(body, "read") else body.read().decode("utf-8")
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw
    if isinstance(value, dict) and isinstance(value.get("error"), str):
        yield {"error": value["error"]}
    else:
        yield {"artifact": {"name": "reply", "text": reply_text(value)}}


def client(region: str):
    import boto3

    return boto3.client("bedrock-agentcore", region_name=region)


def invoke(agent: dict, session: str, text: str) -> int:
    """The run's child process: one InvokeAgentRuntime call, its reply as contract lines on stdout."""
    print(json.dumps({"status": f"invoking {agent['arn'].rsplit('/', 1)[-1]}"}), flush=True)
    try:
        response = client(agent["region"]).invoke_agent_runtime(
            agentRuntimeArn=agent["arn"],
            qualifier=agent["qualifier"],
            runtimeSessionId=session,
            payload=json.dumps({agent["payload_key"]: text}).encode(),
        )
        for event in relay(response):
            print(json.dumps(event), flush=True)
    except Exception as e:  # noqa: BLE001 - boto3 raises many kinds; each is the run's failure
        print(json.dumps({"error": str(e)}), flush=True)
        return 1
    return 0


def stop_session(agent: dict, session: str) -> None:
    try:
        client(agent["region"]).stop_runtime_session(agentRuntimeArn=agent["arn"], runtimeSessionId=session, qualifier=agent["qualifier"])
    except Exception as e:  # noqa: BLE001 - best effort: the session also ends on its idle timeout
        log(f"couldn't stop session {session}: {e}")


def run(params: dict) -> dict:
    agent = agents().get(params.get("agent", ""))
    if not agent:
        raise ValueError(f"there is no AgentCore agent {params.get('agent')!r}")
    task_id = params["taskId"]
    session = session_id(agent["id"], params.get("contextId") or task_id)

    def stop(proc: subprocess.Popen) -> None:
        stop_session(agent, session)
        kill_group(proc)

    runs.start(
        task_id,
        [sys.executable, __file__, "--invoke", agent["id"], session],
        stdin=params.get("input", ""),
        stop=stop,
        label=agent["id"],
    )
    return {}


def health(_: dict) -> dict:
    try:
        import boto3
    except ImportError as e:
        return {"ok": False, "detail": f"boto3 is missing: {e}"}
    if boto3.Session().get_credentials() is None:
        return {"ok": False, "detail": "no AWS credentials for this runner"}
    count = len(agents())
    return {"ok": True, "detail": f"{count} runtime{'' if count == 1 else 's'}"}


METHODS = {
    "describe": lambda _: {"name": "AgentCore", "version": VERSION, "capabilities": ["cancel", "conversations"]},
    "health": health,
    "agents": lambda _: {"agents": [agent_fields(a) for a in agents().values()]},
    "run": run,
    "cancel": runs.cancel,
}


if __name__ == "__main__":
    if sys.argv[1:2] == ["--invoke"]:
        agent_id, session = sys.argv[2], sys.argv[3]
        sys.exit(invoke(agents()[agent_id], session, sys.stdin.read()))
    serve(METHODS, runs)
