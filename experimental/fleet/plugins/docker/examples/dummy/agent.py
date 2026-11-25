"""A dummy container agent for trying the Docker plugin: echoes the input after a few progress steps.

Input "fail" fails the run; "steps=N" sets how many progress steps (default 3, one second apart).
Speaks the one-shot agent contract (plugins/python/README.md#the-agent-contract)."""

import json
import platform
import re
import socket
import sys
import time
from datetime import datetime, timezone


def emit(**event: object) -> None:
    print(json.dumps(event), flush=True)


def main() -> int:
    text = json.load(sys.stdin).get("input", "").strip()
    if text == "fail":
        emit(error="asked to fail")
        return 1
    match = re.search(r"\bsteps=(\d+)", text)
    steps = min(int(match.group(1)), 60) if match else 3
    for step in range(1, steps + 1):
        emit(status=f"thinking ({step}/{steps})")
        time.sleep(1)
    reply = "\n".join(
        [
            f"You said: {text or '(nothing)'}",
            f"Answered from container {socket.gethostname()} ({platform.machine()}, Python {platform.python_version()})",
            f"at {datetime.now(timezone.utc).isoformat(timespec='seconds')}.",
        ]
    )
    emit(artifact={"name": "reply", "text": reply})
    emit(status="done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
