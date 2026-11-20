# POC gaps

What the POC skips or does the simplest way. Each item needs a real decision before v1.

## Decisions deferred
- A2A version: POC uses v1.0 JSON-RPC only (`a2a-rs` + `@a2a-js/sdk`). AgentCore still serves 0.3.x; compat layer not tested.
- Patches vs full Model over SSE: POC sends the full Model on every change.
- Agents are subprocess folders (`agents/<id>/agent.toml`), one runner per machine. The runner reads `agents/` at startup only: adding or changing an agent needs a runner restart. No per-agent resource limits, sandboxing or dependency isolation beyond what the command does (uv envs, optional Docker).
- One SQLite task store per runner shared by all its agents; `ListTasks` on any agent returns every agent's tasks.
- No input-required / approval events in the agent contract yet.
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
- Runner auth: static bearer token over plain HTTP. EC2 runner listens on 127.0.0.1 only and is reached through SSH over SSM (no inbound ports); the local runner is localhost only. No TLS.
- Runner tokens are stored in plain text in the Controller Msg log.
- Controller API: bound to 127.0.0.1 with a token in `~/.agent-fleet/token` (0600). Browser origins are refused unless listed in `FLEET_ALLOWED_ORIGINS`.
- `dev.sh` hardcodes the Controller token `fleet-dev-token` and the local runner token `localtoken`; the pizza-bot screen defaults to the same dev token. Fine for a laptop POC, not for anything shared.

## UI simplified
- The pizza-bot screen and the TUI each keep their own copy of the Model types; no shared package or generated client.
- The pizza-bot screen gets the full Model on every change and re-renders; no patches.
- The TUI has no Inbox or Chats views; only the pizza-bot screen does.
- Inbox cards have generic actions only (Ok got it, Continue in chat, Run again). Agent-specific actions from the mockups ("ok, merge", "Open in browser") need a way for agents to declare actions (e.g. artifact metadata); not designed.
- `[evals]` on agent cards is a disabled stub. "Disabled" agents from the mockup map to unreachable runners; there is no enable/disable intent.

## Morning brief and schedule simplified
- The brief reads only conversation previews (≤255 chars) from `email_inbox` (up to 60 conversations, last 24h) and the day calendar view (text truncated to 12k chars); it never opens full emails.
- Prompt injection is mitigated only by wrapping mail in `<emails>` tags and a system-prompt instruction. Read-only MCP limits the damage; nothing stronger.
- Midway expiry fails the run with a hint; there is no refresh or notification beyond the failed inbox card.
- Schedule is daily only, one time per runner, in the Controller machine's local time zone. No weekdays-only, no cron, no DST special-casing (a 02:30 slot on a spring-forward day still fires on the first tick after 02:30 local).
- A scheduled run that fails is not retried that day.

## Chat simplified
- Replies are one-shot Converse calls, not streamed; the UI shows a typing indicator until the full reply arrives.
- No tools, no memory beyond the chat's own messages; the whole conversation is resent each turn.
- Chats are never deleted or renamed; title is the first message or the source run.
- A failed reply leaves the user message in place; the user just sends again.
- Runner location is in `GET /agents` and also rides in the agent card's `provider.organization`, which is meant for the agent's provider.
- Changing the Controller Model's shape breaks replay of older Msg logs; the old log was set aside, not migrated (no Msg versioning).

## Not tested
- AgentCore, ACP bridge, MCP shim.
- SDK cluster event replay (`a2a-sdk` Python).
- Multi-user fleets.
