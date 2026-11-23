# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
"""Geography fact agent. Input: an optional place. Output: a `fact` artifact. Contract: agents/README.md."""

import json
import os
import sys

import boto3

SYSTEM = (
    "You share surprising, true geography facts. Reply with exactly one fact in one or two sentences, "
    "no intro, no outro. If you are given a place, the fact must be about it; otherwise pick any place on Earth."
)


def emit(**event: object) -> None:
    print(json.dumps(event), flush=True)


def ask(model: str, user: str) -> str:
    client = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-west-2"))
    res = client.converse(
        modelId=model,
        system=[{"text": SYSTEM}],
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": 300, "temperature": 1.0},
    )
    return "".join(block.get("text", "") for block in res["output"]["message"]["content"]).strip()


def main() -> int:
    place = json.load(sys.stdin).get("input", "").strip()
    model = os.environ.get("MODEL", "us.amazon.nova-micro-v1:0")
    emit(status=f"asking {model} for a fact about {place or 'anywhere'}")
    fact = ask(model, f"Place: {place}" if place else "Any place on Earth.")
    if not fact:
        emit(error="the model returned no text")
        return 1
    emit(artifact={"name": "fact", "text": fact})
    emit(status="fact delivered")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # boto/network errors: report them as the run's failure reason
        emit(error=f"{type(e).__name__}: {e}")
        sys.exit(1)
