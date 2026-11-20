# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
"""System report agent. Runs sysinfo.sh, then summarizes it. Contract: agents/README.md."""

import json
import os
import subprocess
import sys
from pathlib import Path

import boto3

SYSTEM = (
    "You are a concise SRE. You get a raw utilization snapshot of one machine. Reply with: one "
    "headline line (overall health: OK / WATCH / HOT), then 3-5 short bullets covering CPU, memory, "
    "disk and any notable processes. Plain text, no markdown headers. If the user asks a specific "
    "question, answer it first."
)


def emit(**event: object) -> None:
    print(json.dumps(event), flush=True)


def ask(model: str, system: str, user: str) -> str:
    client = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-west-2"))
    res = client.converse(
        modelId=model,
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": 4096},
    )
    return "".join(block.get("text", "") for block in res["output"]["message"]["content"]).strip()


def collect() -> str:
    script = Path(__file__).with_name("sysinfo.sh")
    return subprocess.run(["sh", str(script)], capture_output=True, text=True, timeout=60).stdout.strip()


def main() -> int:
    question = json.load(sys.stdin).get("input", "").strip()
    model = os.environ.get("MODEL", "us.anthropic.claude-haiku-5-5")
    emit(status="collecting metrics")
    metrics = collect()
    if not metrics:
        emit(error="the metrics script printed nothing")
        return 1
    emit(artifact={"name": "metrics", "text": metrics})
    emit(status=f"summarizing with {model}")
    user = f"Question: {question}\n\nSnapshot:\n{metrics}" if question else f"Snapshot:\n{metrics}"
    summary = ask(model, SYSTEM, user)
    if not summary:
        emit(error="the model returned no text")
        return 1
    emit(artifact={"name": "summary", "text": summary})
    emit(status="report ready")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        emit(error=f"{type(e).__name__}: {e}")
        sys.exit(1)
