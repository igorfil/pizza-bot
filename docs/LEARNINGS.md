# Learnings

Facts verified while building the POC (Nov 2026), and gotchas that cost time. Each entry says how it
was verified.

## A2A SDKs

### a2a-rs (Rust, `a2a-lf` / `a2a-server-lf` 0.4–0.5, A2A v1.0)
- Official, under `github.com/a2aproject/a2a-rs`. Supports JSON-RPC, HTTP+JSON, gRPC, SSE.
- `DefaultRequestHandler` runs the executor in `tokio::spawn`, so **work continues after the client
  disconnects**. Verified: killed the Controller mid-run, the task completed in the runner's store.
- `SendMessageConfiguration.return_immediately = true` makes `SendMessage` return the task as soon as
  the first event arrives (non-blocking dispatch). Verified with curl.
- Ships only `InMemoryTaskStore`. The `TaskStore` trait is 5 methods (`create`, `update`, `get`,
  `list`, `begin_cancel`); `runner/src/store.rs` implements it on SQLite. `update` must reject
  changing a terminal state (the in-memory store does; we mirror it).
- `subscribe_to_task` on a terminal task returns an error; on a live task it starts with a `Task`
  snapshot event, then streams updates. The Controller treats the stream ending (cleanly or not) as
  `StreamDropped` and follows with `GetTask`.
- `require_streaming()`: subscribe fails unless capabilities declare `streaming: true`; pass the card's
  capabilities via `with_capabilities`.
- No unauthenticated-error constructor on `A2AError`; bearer auth is done as an axum middleware on the
  `/jsonrpc` router instead of a `RequestAuthorizer`, so it returns a proper HTTP 401.
- Headers reach handlers lowercased as `ServiceParams`.
- Wire format is ProtoJSON: `"role":"ROLE_USER"`, `"state":"TASK_STATE_WORKING"`, parts like
  `{"text":"..."}`. Requests need header `a2a-version: 1.0`.
- `ExecutorContext.task_info()` gives `(task_id, context_id)`; `Message::text()` extracts text.

### @a2a-js/sdk (TypeScript, 1.3.0, A2A v1.0)
- `ClientFactory` + `JsonRpcTransportFactory`; `createFromUrl(base)` fetches the agent card and uses
  its `supportedInterfaces` URL. **That URL must be reachable from the client**, which is why the EC2
  runner advertises the tunnel URL.
- Types are protobuf-generated with required fields (`tenant: ""`, `metadata: undefined`, …) and
  oneofs as `{ $case: "text", value }`. `TaskState`/`Role` are numeric enums.
- Methods: `sendMessage`, `getTask`, `cancelTask`, `resubscribeTask` (= A2A `SubscribeToTask`).
- Auth: pass `{ serviceParameters: { Authorization: "Bearer …" } }` per call; per-call timeouts via
  `signal: AbortSignal.timeout(ms)`.
- `sendMessage` returns `Message | Task`; check for `status` to tell them apart.

## Controller design that worked
- Reconnect falls out of subscription reconciliation: the Model says which streams should be open;
  `StreamDropped` bumps an epoch and sets a retry time; the runtime opens whatever is wanted and
  closes the rest. No separate reconnect routine.
- Wake detection without OS hooks: if two Ticks are more than 10s apart, mark runners `unknown`
  (closes streams), re-check them, and `RunnerOk` re-fetches their open runs. TCP streams often hang
  silently after sleep, so waiting for a stream error is not enough.
- Only health checks drive runner backoff. Counting failed `GetTask`s too doubled the backoff
  (6 failures in 8s) and delayed recovery to 30s+; a failed fetch now just schedules an early check.
- Logging every Msg (including Ticks) and replaying on boot rebuilt state exactly. A Controller
  killed mid-dispatch leaves the task `dispatching`; `Booted` marks it `lost`.

## UIs
- Browser `EventSource` cannot send `Authorization`; read SSE over `fetch` with a parser
  (`eventsource-parser`) instead.
- Browsers always send `Origin`; the Controller allowlists origins via `FLEET_ALLOWED_ORIGINS` and
  answers preflight. Electron packaged apps load from `file://` (origin `null`).
- TUI: in raw mode `\n` doesn't return the carriage; render each row with an absolute cursor move.
- Keep `view` pure: screens can then be rendered from the live Model in a script, which made layout
  checks possible without a terminal.
- Don't edit `dev.sh` while it runs: bash reads scripts incrementally, so an edit shifts offsets and
  the running copy fails with a bogus syntax error.
- The Electron dev app runs on `localhost:5273`, plain Vite on `5173`; both must be in
  `FLEET_ALLOWED_ORIGINS`.

## AWS / EC2
- `t4g.nano` (512 MB) OOMs with the SSM agent plus account SSM documents; use `t4g.small`.
- Stopping an OOM'd instance takes minutes.
- User-data runs only on first boot; changing the instance type doesn't re-run it.
- SSH over SSM (`AWS-StartSSHSession`) gives a tunnel with zero inbound rules. Needs
  `AmazonSSMManagedInstanceCore` on the role and outbound internet.
- Port 9400 on the laptop is taken by OpenVPN; `lsof` as a user didn't show it, `netstat -anv` did.
- `ssh -L 9400:…` may bind only `[::1]` when IPv4 is busy; bind `127.0.0.1:` explicitly.
- `aws-sdk-rust` in a static musl build needs `cmake make perl clang` for `aws-lc-sys`; binary
  grows from 7 MB to 19 MB.
- The aws-mcp `call_boto3` takes keyword args only and PascalCase operation names.

## Bedrock
- Available in us-west-2 for this account (Nov 2026): Claude Haiku/Sonnet/Opus 4.x–5.5 and Fable
  profiles, Nova, and OpenAI `gpt-5.6-terra` / `gpt-6.1-terra` (`us.` and `global.` profiles).
- "terra" = `us.openai.gpt-6.1-terra`. Works with the Converse API unchanged.
- Model output often includes markdown bold (`**`); the UIs strip it.
- `maxTokens: 1000` silently truncated the morning brief at ~650 visible characters: Haiku 5.5 spends
  output tokens before the visible text. Verified by logging `stopReason=MaxTokens`, output 1000. Now
  4096 everywhere, and a `max_tokens` stop appends "(cut off …)" instead of passing silently.

## Outlook MCP (aws-outlook-mcp 0.10.0, via aim/toolbox)
- Binary at `~/.toolbox/bin/aws-outlook-mcp`, stdio, MCP protocol `2025-06-18`. Read-only by default
  (10 write tools skipped; `OUTLOOK_MCP_ENABLE_WRITES=true` would enable them; we don't).
- Tool results are text wrapped in an `<untrusted_content_…>` tag around JSON; parse the first JSON
  value inside.
- `email_inbox {limit}` → `content.emails[]` of conversations: `topic, senders[], recipients[],
  lastDeliveryTime (RFC 3339 with offset), preview (≤255 chars), unreadCount, hasAttachments,
  messageCount, itemIds[]`. No date filter; filter by `lastDeliveryTime` client-side.
- `calendar_view {view: "day", start_date: "MM-DD-YYYY"}` (note the date format differs from the
  email tools' `YYYY-MM-DD`).
- Spawning it per run costs ~1s handshake; fine for a daily brief.

## Subprocess agents
- `@a2a-js/sdk` `createFromUrl(base)` resolves the card with `new URL("/.well-known/agent-card.json",
  base)`, an absolute path that drops any base path. With agents at `/agents/<id>/` that 404s. Pass a
  relative path with a trailing-slash base: `createFromUrl(base + "/", ".well-known/agent-card.json")`.
- Put the agent in its own process group (`process_group(0)`) and signal `-pgid`: `sh -c "uv run …"`
  starts uv, which starts Python; signalling only the shell leaves the Python running. Verified: no
  `agent.py` left after cancel.
- Python MCP SDK (`mcp` ≥1.10): `CallToolResult.is_error` (snake_case; `isError` raises).
  `StdioServerParameters(env=None)` passes a minimal environment; pass `dict(os.environ)` so the
  Outlook server sees Midway, `PATH`, `HOME`.
- asyncio/anyio wrap failures in `ExceptionGroup` ("unhandled errors in a TaskGroup"); unwrap to the
  first leaf before reporting, or the run's failure reason says nothing useful.
- `uv run` with PEP 723 inline deps: first run on a box downloads Python (AL2023 ships 3.9) and
  wheels into the user's cache; `uv sync --script agent.py` pre-warms it.
- zsh doesn't word-split `$x` and treats `|` in `${a%%|*}` as alternation; shell loops in test
  scripts silently passed wrong arguments. Use arrays or separate commands.

## rmcp (Rust MCP SDK 3.11) — used before agents moved out of the runner
- Client over stdio: features `client`, `transport-child-process`;
  `().serve(TokioChildProcess::new(Command::new(cmd))?)`, then
  `call_tool(CallToolRequestParams::new(name).with_arguments(map))`. Result content is
  `Vec<ContentBlock>` (`ContentBlock::Text(t)`), errors flagged by `is_error`.
