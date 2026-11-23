# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
"""Agent created from the Fleet page: one Bedrock call with this folder's system.md and $MODEL.
Written by the runner; contract: agents/README.md."""

import json
import os
import sys
from pathlib import Path

import boto3


def emit(**event: object) -> None:
    print(json.dumps(event), flush=True)


def main() -> int:
    message = json.load(sys.stdin).get("input", "").strip()
    if not message:
        emit(error="send a message for the agent to answer")
        return 1
    model = os.environ["MODEL"]
    system = Path("system.md").read_text(encoding="utf-8").strip()
    emit(status=f"asking {model}")
    client = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-west-2"))
    res = client.converse(
        modelId=model,
        **({"system": [{"text": system}]} if system else {}),
        messages=[{"role": "user", "content": [{"text": message}]}],
        inferenceConfig={"maxTokens": 4096},
    )
    reply = "".join(block.get("text", "") for block in res["output"]["message"]["content"]).strip()
    if not reply:
        emit(error="the model returned no text")
        return 1
    emit(artifact={"name": "reply", "text": reply})
    emit(status="answered")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # boto/network errors: report them as the run's failure reason
        emit(error=f"{type(e).__name__}: {e}")
        sys.exit(1)
