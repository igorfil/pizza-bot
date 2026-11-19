# POC gaps

What the POC skips or does the simplest way. Each item needs a real decision before v1.

## Decisions deferred
- A2A version: POC uses v1.0 JSON-RPC only (`a2a-rs` + `@a2a-js/sdk`). AgentCore still serves 0.3.x; compat layer not tested.
- Patches vs full Model over SSE: POC sends the full Model on every change.
- Runner plugin model: POC has three hardcoded agents (`fake`, `dadjokes`, `sysreport`), one per runner process, picked by env var.
- Bedrock calls are one-shot `Converse`, not streamed; the UI shows no partial output while the model writes.
- Model output may contain markdown; the TUI strips `**` and nothing else.

## Definitions not written down yet
- Domain types (Runner, Task, Artifact) exist only in `controller/src/types.ts`. No schema / OpenAPI.
- Msg, Effect, Sub catalogue is only in code. No versioning on Msg types.
- State transition table per Msg is only in `update.ts`.
- Backoff and timing constants are hardcoded (tick 2s, health 15s, backoff 2^n capped at 30s, resync 30s, wake gap 10s).
- Controller API: no error schema, no OpenAPI, no generated clients.
- CLI not built; TUI talks to the API directly.

## Behaviour simplified
- Msg log: every Msg including `Tick` is logged, no snapshots, no compaction. Replay reads the full log.
- Artifacts: text artifacts stored inline in the Model. No blob store, no `/artifacts/{id}`.
- Dispatch idempotency: if the Controller dies mid-dispatch, the task is marked `lost` on boot. No dedupe by `messageId`.
- Runner restart mid-task: orphaned `submitted` / `working` tasks are marked `failed` on startup. No resume.
- Stale streams after sleep: detected by a gap between Ticks, plus a periodic `GetTask` resync. No stream heartbeats.
- Event ordering: a snapshot always wins over stream events; no timestamp comparison.
- Approvals (`input-required`): state is displayed, responding is not implemented.

## Security simplified
- Runner auth: static bearer token over plain HTTP. EC2 port open only to the laptop IP. No TLS.
- Runner tokens are stored in plain text in the Controller Msg log.
- Controller API: bound to 127.0.0.1 with a token in `~/.agent-fleet/token` (0600). No CORS handling beyond rejecting browser origins.

## Not tested
- AgentCore, ACP bridge, MCP shim.
- SDK cluster event replay (`a2a-sdk` Python).
- Multi-user fleets.
