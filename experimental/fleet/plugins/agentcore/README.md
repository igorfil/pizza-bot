# AgentCore plugin

Runs agents deployed to Amazon Bedrock AgentCore Runtime. Each folder in `agents/` (or
`AGENTCORE_AGENTS_DIR`) is one agent: a runtime ARN, invoked with `InvokeAgentRuntime` once per task
with `{"prompt": "<input>"}`. Deploying the runtime is up to you (the AgentCore CLI, or its console);
the plugin only invokes it. There are no agents here, since each needs a runtime in your account.

```toml
name = "Support agent"                    # shown in UIs
description = "Answers support questions."
runtime_arn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/support_agent-AbC123"   # required
qualifier = "DEFAULT"                     # optional; the endpoint
region = "us-west-2"                      # optional; read from the ARN
payload_key = "prompt"                    # optional; the payload is {"<payload_key>": "<input>"}
timeout_secs = 900                        # optional, default 600

[input]                                   # optional; how UIs label the input box
label = "Question"
```

The reply becomes the `reply` artifact: a JSON reply's `result`, `response`, `output`, `text`,
`message` or `content` field, or the whole JSON; a streaming reply (`text/event-stream`) is joined
into one. A streamed or JSON object with `status`, `artifact` or `error` passes through as that
event, so a runtime can report progress. One Fleet conversation (`contextId`) is one runtime session
(`runtimeSessionId`), so follow-ups reach the same session. Cancel and timeout call
`StopRuntimeSession`.

The runner's AWS credentials (on EC2, the instance role) need `bedrock-agentcore:InvokeAgentRuntime`
and `bedrock-agentcore:StopRuntimeSession` on the runtime. The plugin is healthy when it finds AWS
credentials; `uv` installs boto3 for it on first start.

## Testing

```bash
uv run --with boto3 python -m unittest discover -s experimental/fleet/plugins/agentcore
```

The API tests check every call against botocore's model of the `bedrock-agentcore` API; they are
skipped without boto3. They don't reach a real runtime.
