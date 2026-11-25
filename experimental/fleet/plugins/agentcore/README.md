# AgentCore plugin

Runs agents deployed to Amazon Bedrock AgentCore Runtime: a runtime ARN, invoked with
`InvokeAgentRuntime` once per task with `{"prompt": "<input>"}`. Each agent is added on the Fleet
page (Add agent → Add existing → AgentCore), which keeps it as an `agent.toml` in the plugin's data
folder (`$FLEET_PLUGIN_DATA/agents/<id>/`). Deploying the runtime is up to you (the AgentCore CLI, or
its console); the plugin only invokes it.

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
credentials. It uses the AWS SDK for JavaScript, bundled into its `plugin.mjs`.

## Testing

```bash
npm test -w @pizza-bot/fleet-plugins
```

The calls are built with the SDK's own command types, so the typecheck catches a wrong operation or
field; the tests use a fake client and don't reach a real runtime.
