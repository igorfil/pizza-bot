"""Slow test agent: `steps=N every=S <text>`. No dependencies. Contract: plugins/python/README.md."""

import json
import re
import sys
import time
from datetime import datetime, timezone


def emit(**event: object) -> None:
    print(json.dumps(event), flush=True)


def plan(prompt: str) -> tuple[int, float, str]:
    def value(key: str, default: float) -> float:
        m = re.search(rf"\b{key}=(\d+(?:\.\d+)?)", prompt)
        return float(m.group(1)) if m else default

    text = " ".join(w for w in prompt.split() if not w.startswith(("steps=", "every=")))
    return int(value("steps", 10)), value("every", 3), text


def main() -> int:
    steps, every, text = plan(json.load(sys.stdin).get("input", ""))
    for step in range(1, steps + 1):
        emit(status=f"step {step}/{steps}")
        time.sleep(every)
    emit(artifact={"name": "result", "text": f"done: {text} ({steps} steps, finished {datetime.now(timezone.utc).isoformat()})"})
    emit(status="completed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
