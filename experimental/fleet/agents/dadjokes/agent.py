# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3"]
# ///
"""Dad jokes agent. Input: a topic. Output: a `jokes` artifact. Contract: agents/README.md."""

import json
import os
import sys

import boto3

SYSTEM = (
    "You are a dad-joke machine. Given a topic, reply with exactly 5 short, groan-worthy dad jokes "
    "about it, one per line, numbered 1-5. No intro, no outro."
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


def main() -> int:
    topic = json.load(sys.stdin).get("input", "").strip() or "anything"
    model = os.environ.get("MODEL", "us.openai.gpt-6.1-terra")
    emit(status=f"asking {model} for jokes about {topic}")
    jokes = ask(model, SYSTEM, f"Topic: {topic}")
    if not jokes:
        emit(error="the model returned no text")
        return 1
    emit(artifact={"name": "jokes", "text": jokes})
    emit(status="jokes delivered")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # boto/network errors: report them as the run's failure reason
        emit(error=f"{type(e).__name__}: {e}")
        sys.exit(1)
