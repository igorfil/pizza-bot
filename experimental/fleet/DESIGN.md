# Fleet: design

Status: POC, working end to end on one laptop and one EC2 instance (Nov 2026). This document
describes the system as built, component by component, and lists the questions each component
still has to answer. Each component's questions are numbered (`Q-<component>-n`) so they can be
referenced in reviews and issues.

Related documents:
- [SPEC.md](SPEC.md): the original problem statement, constraints and decisions (D1–D6), and the
  POC scope. This document doesn't repeat the reasoning behind those decisions.
- [POC-GAPS.md](POC-GAPS.md): everything deliberately skipped.
- [README.md](README.md): how to run it, the API, config.
- [agents/README.md](agents/README.md): the agent contract.
- [docs/UI.md](docs/UI.md), [docs/DEPLOY.md](docs/DEPLOY.md), [docs/LEARNINGS.md](docs/LEARNINGS.md).

History: built as a standalone repo (`agent-fleet`: Bun Controller, Rust runner, a TUI, and the
pizza-bot screen as a patch). It was then imported into pizza-bot-experimental with its git
history: the Controller was ported to Node and added to the npm workspace, the screen became a
page in `apps/web`, and the TUI was dropped.

---

## 1. Goal and constraints

Orchestrate, observe and control AI agents that run on other machines, from a laptop that sleeps.
The hard constraints are in SPEC.md §2. The two that shape every component:

- **C3: the laptop is never in the critical path.** Agents finish without it; the laptop catches up.
- **C4/C5: headless Controller, thin UIs, The Elm Architecture (TEA).** UIs send intents and render a
  Model; they never hold fleet state.

Inside pizza-bot-experimental, the fleet is a **second, independent backend** next to pizza-bot's
api-server. They share the web app and nothing else; ESLint enforces the import boundary in both
directions.

## 2. System overview

```
 apps/web Fleet page ──HTTP+SSE──▶ Controller (laptop, :7700) ──A2A JSON-RPC──▶ Runner "laptop" (:9301) ─▶ agents (subprocesses)
 (also: pizza-bot UI ──▶ api-server, untouched)     │                  └──A2A over SSH-over-SSM──▶ Runner "ec2" ─▶ agents
                                                    └── Bedrock (chat)
```

| # | Component | Code | Runs as |
|---|---|---|---|
| 3.1 | Fleet page | `apps/web/src/components/fleet/` | part of the pizza-bot web app (browser or Electron) |
| 3.2 | Controller API | `controller/src/api.ts` | inside the Controller process |
| 3.3 | Controller core (TEA) | `controller/src/types.ts`, `update.ts` | inside the Controller process, pure |
| 3.4 | Controller runtime and effects | `controller/src/runtime.ts`, `a2a.ts`, `llm.ts` | inside the Controller process |
| 3.5 | Msg log | `controller/src/log.ts` | `~/.agent-fleet/controller.db` |
| 3.6 | Scheduler | `update.ts` (`dueSchedules`, `setSchedule`) | inside `update` |
| 3.7 | Inbox and chat | `update.ts` (`inboxOf`), `chat.ts` | inside `update` |
| 3.8 | Runner | `runner/src/main.rs`, `exec.rs`, `manifest.rs` | one process per machine (Rust) |
| 3.9 | Runner task store | `runner/src/store.rs` | one SQLite file per runner |
| 3.10 | Agents | `agents/<id>/` | a subprocess per run |
| 3.11 | Remote deployment and network | `deploy/` | EC2 + systemd, SSH-over-SSM tunnel |
| 3.12 | Security | spread across the above | |
| 3.13 | pizza-bot integration (build, dev, boundary) | `package.json`, `scripts/*fleet*`, `scripts/dev*.mjs`, `eslint.config.js` | developer tooling |

Section 4 covers how the components work together: one run, and recovery from failures. Section 5
holds the questions about the fleet as a whole.

---

## 3. Components

### 3.1 Fleet page (UI)

**Role.** A view of the Controller: renders the Controller's Model and sends intents. Three tabs
(Inbox, Chats, Agents) plus a connection form. Details in [docs/UI.md](docs/UI.md).

**Interfaces.** `POST /msg` (intents, via `sendFleetIntent`) and `GET /model/stream` (SSE read over
`fetch`, because `EventSource` can't send `Authorization`). Nothing else; it imports no fleet code.

**State.** Only local UI state (selected tab, drafts, open card). The connection (`url`, `token`) is
in `localStorage` under `pizza.fleet.connection`, and defaults to `http://127.0.0.1:7700` +
`fleet-dev-token`.

**Behaviour.**
- Every SSE event carries the **full** public Model; the page replaces its copy and re-renders.
- Reconnects every 2 s; stops on 401/403 and shows the exact fix.
- The stream is open app-wide, for the rail's unread count and desktop notifications.
- `fleet-types.ts` is a hand-kept mirror of the Controller's public Model.

**Limits today.** No approval UI (`input-required` is shown as a state only). Inbox actions are
generic (Ok / Run again / Continue in chat). The `[evals]` button is a stub.

**Open questions.**
- Q-UI-1 **Relationship to pizza-bot's own inbox.** pizza-bot already has an inbox (All / Unread /
  Action), automations (cron triggers) and chat. The Fleet page has its own Inbox, Chats and
  schedules. Are they meant to merge? For example, fleet results could appear in pizza-bot's
  Unread, or fleet runs could become pizza-bot threads. Or should they stay separate on purpose?
  This decides most of the UI roadmap.
- Q-UI-2 **Type drift.** `fleet-types.ts` is hand-kept and must match `controller/src/types.ts`.
  Generate it (OpenAPI / JSON Schema → TS), share a types-only package that the boundary rules
  allow, or keep it hand-kept and add a contract test?
- Q-UI-3 **Model size.** The full Model is sent on every change. Tasks, artifacts (inline text) and
  chats are never pruned, so the payload only grows. When do we switch to patches (SPEC §6: JSON
  Patch with `from`/`to` versions) or paged task history?
- Q-UI-4 **Packaged Electron.** The packaged app loads from `file://` (origin `null`). How does it
  get through the Controller's origin allowlist, and how does a real user get the token, given the
  dev token is hardcoded and the real one lives in `~/.agent-fleet/token`? Options: the shell reads
  the token file and passes it to the renderer, or the shell starts the Controller as a sidecar,
  like it does for the api-server.
- Q-UI-5 **Approvals.** What does responding to `input-required` look like (form from the agent's
  request? free text?), and which intent carries it (`RespondToTask`)?
- Q-UI-6 **Agent-declared actions** ("ok, merge", "open in browser" from the mockups): how does an
  agent declare them (artifact metadata, card extension), and what does the Controller do when one
  is clicked?

### 3.2 Controller API

**Role.** The only way into the Controller. HTTP + JSON on Hono (`@hono/node-server`), bound to
`127.0.0.1:7700`.

**Interfaces.**

| Endpoint | |
|---|---|
| `POST /msg {msg_id, type, payload}` | intent only; world Msgs are rejected. `202 {accepted_at_version, id}`; repeated `msg_id` → `200 duplicate` |
| `GET /model` | `{version, model}` (runner tokens stripped by `publicModel`) |
| `GET /model/stream` | SSE, full `{version, model}` per change, keepalive every 15 s |

Intents: `AddRunner, RemoveRunner, CreateTask, CancelTask, AckInbox, AckAllInbox, CreateChat,
SendChatMessage, SetSchedule`.

**Behaviour.**
- **Ids are minted here** (task ids, chat ids) before `update` sees the Msg, so `update` stays pure
  and replay reproduces the same ids.
- **Auth:** a bearer token from `~/.agent-fleet/token` (0600; generated on first start).
- **Origins:** a request with an `Origin` header must be in `FLEET_ALLOWED_ORIGINS`, otherwise 403.
  Allowed origins get CORS headers and preflight replies.

**Open questions.**
- Q-API-1 **Contract.** SPEC D5 says the API contract is the product (OpenAPI + Msg/Model schema,
  generated clients). None of that exists yet. Is that still the plan, and does it come before more
  UIs (CLI, MCP shim)?
- Q-API-2 **Where errors go.** Shape errors return 400; semantic errors (unknown agent, runner
  already exists) become Model notifications, and the request still gets 202. Is that split
  intended? It means a UI can't tell that its own `CreateTask` failed except by watching
  notifications.
- Q-API-3 **Resume.** SSE events carry `id: <version>`, but `Last-Event-ID` is ignored; every
  connection starts with a full snapshot. That's fine while full Models are sent; decide together
  with Q-UI-3.
- Q-API-4 **Transport.** SPEC §11 prefers a Unix socket or 127.0.0.1. Is TCP on localhost enough,
  given any local process with the token can drive the fleet? And remote UI access (phone, over
  Tailscale) is planned as opt-in: what does it require?
- Q-API-5 **Port and instance.** The port is fixed at 7700 and the home dir is shared. What happens
  with two checkouts or two users on one machine?

### 3.3 Controller core (TEA)

**Role.** The fleet's source of truth: `update(Model, Msg) → (Model, Effect[])`, pure, plus
`subscriptions(Model) → Sub[]`.

**Model.** `runners` (health, URL, token, location, backoff), `agents` (key `<runner>/<id>`, card
info, schedule), `tasks` (state, status text, inline artifacts, stream epoch/backoff, `ackedAt`,
`trigger`), `chats`, `notifications` (last 20), `now`, `local` (local calendar position).

**Msgs.** Intents (above) and world Msgs: `Booted, Tick, RunnerOk, RunnerFailed, Dispatched,
DispatchFailed, TaskSnapshot, TaskUpdated, SyncFailed, StreamDropped, CancelFailed, ChatReplied,
ChatFailed`.

**Effects.** `CheckRunner, Dispatch, GetTask, Cancel, ChatComplete`. **Sub:** `TaskStream` keyed
`taskId#epoch`.

**Key behaviours.**
- **Reconnect is reconciliation.** The runtime keeps a stream open for every non-terminal task on a
  healthy runner whose retry time has passed. `StreamDropped` bumps the epoch, backs off, and
  schedules `GetTask`.
- **Wake detection.** A gap between Ticks greater than 10 s means the laptop woke up. Every runner
  goes to `unknown` (closing its streams), gets re-checked, and `RunnerOk` re-fetches its open tasks.
- **Backoff comes only from health checks** (`2^(n-1)` s, capped at 30 s). A failed `GetTask` only
  requests an early check.
- **On boot**, tasks still `dispatching` become `lost`, and chats that were waiting for a reply
  become failed.
- **Snapshots win over stream events;** terminal tasks ignore further updates.
- **Timing constants** live in `update.ts`: tick 2 s, health 15 s, resync 30 s, wake gap 10 s.

**Open questions.**
- Q-CORE-1 **Model retention.** Tasks, artifacts and chats are never removed, from the Model or the
  log. What is the retention policy (age, count, "acked and older than N days"), and does pruning
  happen through a Msg, so replay stays exact?
- Q-CORE-2 **`RemoveRunner` orphans tasks.** It removes the runner and its agents, but leaves its
  tasks. Non-terminal ones never resolve: they get no stream, no resync and no inbox entry. Should
  they become `lost`, or should removal be refused while tasks are open?
- Q-CORE-3 **Event ordering.** "Snapshot always wins" can move a task backwards if a stale
  `GetTask` reply arrives after a newer stream update. Is that acceptable, or should snapshots
  carry a runner-side version or timestamp (the runner store already has a `version` column)?
- Q-CORE-4 **Wake detection on other platforms.** The tick-gap heuristic needs no OS hooks. Is it
  enough everywhere (Windows sleep, a VM paused by its host), or should it also listen to Electron's
  `powerMonitor` when the Controller runs under the shell?
- Q-CORE-5 **Mapping A2A `auth-required`.** It maps to `input-required`. Should it be its own state,
  since the user's fix differs (re-auth versus answering a question)?
- Q-CORE-6 **Tunable constants.** Should the timing constants be configurable per runner? A remote
  runner over a tunnel may want slower health checks than localhost.

### 3.4 Controller runtime and effects

**Role.** The impure shell around `update`: a single update loop, the effect executor, the stream
reconciler, a 2 s Tick timer, and the adapters. `a2a.ts` is the only file that knows A2A; `llm.ts`
is the only file that knows Bedrock.

**A2A adapter (`@a2a-js/sdk` 1.3, A2A v1.0 JSON-RPC).**
- `checkRunner` is `GET <runner>/agents` (discovery and health in one call, 5 s timeout).
- `dispatch` is `SendMessage` with `returnImmediately: true`.
- `getTask`, `cancel` and `stream` (`SubscribeToTask`) complete the set; every call has a 10 s
  timeout.
- Clients are cached per agent URL. The agent card is fetched with a *relative* path, so the
  `/agents/<id>/` prefix survives.

**LLM adapter.** Bedrock Converse, model from `FLEET_CHAT_MODEL` (default
`us.anthropic.claude-haiku-5-5`), `maxTokens` 4096, 60 s timeout, credentials from the default AWS
chain.

**Open questions.**
- Q-RT-1 **Dispatch idempotency.** Each `Dispatch` sends a random `messageId`. If the Controller dies
  between sending and logging `Dispatched`, the task becomes `lost`, but the runner may already be
  running it, which gives a duplicate run on retry. Should `messageId` be the Controller task id,
  with the runner deduplicating on it (R7 in SPEC §10)?
- Q-RT-2 **Client cache invalidation.** The cache is never cleared. If a runner's card changes
  (new public URL, an agent removed), the stale client keeps calling the old interface URL. Should
  the cache be dropped on `RunnerFailed`, or whenever the card changes?
- Q-RT-3 **A2A versions.** Only v1.0 JSON-RPC is supported. AgentCore still serves 0.3.x (SPEC §9).
  Do we need a 0.3 adapter, and is AgentCore still a target?
- Q-RT-4 **Should chat be in the Controller at all?** Chat makes the Controller depend on an LLM
  provider and AWS credentials, on a different config path from pizza-bot's own model providers.
  pizza-bot already has a chat runtime with tools. Options: keep it, delegate chat to the api-server
  over HTTP (which crosses the "share nothing" boundary), or make chat just another agent on a
  runner.
- Q-RT-5 **Many open streams.** Each non-terminal task holds its own SSE stream. With many
  long-running tasks, should streams be multiplexed per runner, or tasks polled instead?

### 3.5 Msg log

**Role.** Durable history of every Msg (intents, world results, and the Ticks that matter).
Replaying it rebuilds the exact Model.

**Storage.** `better-sqlite3` in WAL mode, table `msgs(seq, msg_id UNIQUE, at, body JSON)`. Each Msg
is appended before its effects run. A quiet Tick (no effects, only `now`/`local` changed) is held
back; the latest one is logged right before the next Msg, so later Msgs replay at the right time,
and `Tick.since` keeps wake detection exact. On start: replay with effects dropped, then `Booted`. `msg_id`
uniqueness gives API idempotency forever.

**Observed.** Before quiet Ticks were held back, 80 % of the dev laptop's 5,650 rows were `Tick`
(about 43,000 a day). Now an idle Controller logs about two Ticks per health check (every 15 s).

**Open questions.**
- Q-LOG-1 **Snapshots and compaction.** Replay reads the whole log on every boot. When do we add
  periodic Model snapshots (SPEC D6 rule 6) and drop or compact older Msgs? Old logs still hold
  every Tick from before quiet Ticks were held back.
- Q-LOG-2 **Msg versioning.** Changing the Model's shape broke replay once (the old log was set
  aside as `controller.db.v1-runner-per-agent`, not migrated). What is the versioning scheme:
  version per Msg type, upcasters, or "snapshot then truncate" on upgrade?
- Q-LOG-3 **Secrets in the log.** Runner tokens are stored in plain text inside `AddRunner` Msgs.
  Should they move to the OS keychain (pizza-bot's desktop shell already uses one), with the log
  holding only a reference?
- Q-LOG-4 **Backup and debugging.** The log is meant to give time-travel debugging (SPEC §12). Do
  we ship a tool to replay a log up to version N and inspect the Model?

### 3.6 Scheduler

**Role.** Run an agent once a day at a local time. `SetSchedule {agent, at: "HH:MM" | empty,
prompt}`.

**Behaviour.**
- The runtime puts the local calendar position into each Tick (`local: {day, minute}`), so `update`
  stays pure.
- An agent fires on the first Tick at or after `at` whose day differs from `lastScheduledDay`. A
  laptop that slept through 07:30 runs the brief when it wakes.
- The task id is `schedule:<runner>/<id>:<day>`, so each slot runs once and replay is safe.
- Setting a time that has already passed today waits for tomorrow.
- Schedules live on the Controller's `Agent` record and survive the runner re-reporting its agents.

**Limits.** Daily only, one slot per agent, the Controller machine's time zone, no retry of a failed
run, no DST handling.

**Open questions.**
- Q-SCHED-1 **This breaks C3.** Schedules live in the Controller, on the laptop. A scheduled run of
  an EC2 agent doesn't fire while the laptop sleeps, even though the agent could run. Should
  schedules move to the runners (each runner owns its cron and the Controller only mirrors it), or
  is "fires on wake" acceptable?
- Q-SCHED-2 **Two schedulers.** pizza-bot's `TriggerService` already does cron and webhook triggers
  with missed-run recovery and durable occurrences. Reuse its trigger model and semantics, or keep
  a separate one on purpose? See Q-UI-1.
- Q-SCHED-3 **Richer schedules.** Weekdays-only, multiple slots, cron, explicit time zones, retry
  after failure: which are needed, and in what syntax (cron like pizza-bot)?

### 3.7 Inbox and chat

**Inbox.**
- The inbox is the finished tasks (`completed, failed, canceled, rejected, lost`) with `ackedAt`
  null, newest first.
- There is no separate store: `AckInbox` / `AckAllInbox` set `ackedAt`.

**Chat.**
- Chats live in the Model and the log, so every UI sees the same chats.
- `CreateChat {text?, fromTaskId?}` and `SendChatMessage` append the user message and emit
  `ChatComplete`.
- A chat started from a run puts the run (agent, input, outcome, artifacts) in the system prompt.
- Message ids come from their position, so replay reproduces them.
- The whole conversation is resent on each turn. There are no tools, and no streaming of the reply.

**Open questions.**
- Q-INBOX-1 **Per-user state.** Is "acked" per user or per fleet? It's per fleet today. That
  matters once more than one person or device shares a Controller (Q-FLEET-3).
- Q-INBOX-2 **Context size.** Artifacts go into the chat's system prompt unbounded. What happens
  with a large artifact: truncate, summarize, or pass it by reference?
- Q-INBOX-3 **Chat lifecycle.** Chats can't be renamed or deleted, and there's no limit on how long
  a conversation can get. Needed before real use?
- Q-INBOX-4 **Chat with actions.** Should a chat be able to act ("run it again with X", "schedule
  this daily")? Doing so would turn the chat into an agent with fleet intents as tools; see Q-RT-4.

### 3.8 Runner

**Role.** A generic host, one per machine. It serves every agent folder in `RUNNER_AGENTS_DIR` as
its own A2A endpoint, and knows nothing about what agents do. It is built on the official `a2a-rs`
SDK (`a2a-lf` / `a2a-server-lf`) with axum.

**Interfaces.**
- `GET /agents` (public): `{runner, location, agents[]}`, used for discovery and health checks.
- `/agents/<id>/.well-known/agent-card.json` (public): one skill per agent, carrying the input
  label, hint and example.
- `/agents/<id>/jsonrpc`: A2A v1.0 JSON-RPC; requires the bearer token (axum middleware, so a bad
  token gets a real HTTP 401).

**Execution (`exec.rs`).**
- Each run is `sh -c <command>` in the agent folder, in its own process group.
- Input goes in as JSON on stdin; events come back as JSON lines on stdout (`status`, `artifact`,
  `error`).
- The exit code decides the outcome; stderr goes to the runner log, and its last line becomes the
  failure reason.
- Cancel and timeout send SIGTERM to the group, then SIGKILL 5 s later.
- Work continues after the client disconnects, because the SDK runs the executor in `tokio::spawn`.

**Config.** `RUNNER_TOKEN` (required), `RUNNER_AGENTS_DIR`, `RUNNER_AGENTS`, `RUNNER_BIND`,
`RUNNER_PUBLIC_URL`, `RUNNER_DB`, `RUNNER_NAME`, `RUNNER_LOCATION`.

**Open questions.**
- Q-RUN-1 **Windows.** `exec.rs` uses `process_group` and `libc::kill`, which exist only on Unix,
  with no `cfg(windows)` path. So the runner most likely doesn't build on Windows. (This is from
  reading the code; it hasn't been tried on a Windows machine.) pizza-bot supports Windows, its CI
  builds on `windows-latest`, and `npm run build` now builds the runner. Options: a Windows
  implementation (Job Objects for group kill), excluding the runner from Windows builds, or declaring
  the fleet Unix-only.
- Q-RUN-2 **Resume after restart.** A run that is in flight when the runner restarts is marked
  `failed` (`fail_orphans`). Should the runner re-run idempotent agents, or let agents checkpoint
  and resume (SPEC R6/R7)?
- Q-RUN-3 **Hot reload.** `agents/` is read only at startup, so adding or changing an agent needs a
  restart (which fails in-flight runs, Q-RUN-2). Should the runner watch the folder, or offer a
  reload endpoint?
- Q-RUN-4 **Concurrency limits.** There are none: every `SendMessage` spawns a process. Do we need
  per-agent or per-runner limits and a queue (`submitted` would then mean queued)?
- Q-RUN-5 **Cancel semantics.** The executor reports `canceled` right away, before the process has
  actually exited (up to 5 s later). Is it acceptable that a canceled run may still write its last
  side effects?
- Q-RUN-6 **Public endpoints.** `GET /agents` and the agent cards need no auth, so anyone who can
  reach the port sees the agent list. Fine for localhost and the tunnel; what about a runner on a
  public host (SPEC §8)?
- Q-RUN-7 **`RUNNER_PUBLIC_URL`.** Agent cards advertise the URL the Controller must call, so the EC2
  runner advertises the laptop end of the tunnel. That works for exactly one Controller with one
  tunnel layout. Should the Controller instead ignore the card's interface URL and always use
  `<runner url>/agents/<id>/jsonrpc`?
- Q-RUN-8 **Other agent sources.** SPEC's build order includes an ACP bridge (Claude Code, Kiro as
  subprocesses) and native A2A agents (Strands). Are they still in scope? Each needs an adapter on
  the runner or a direct A2A endpoint the Controller can add.

### 3.9 Runner task store

**Role.** Durable A2A task state for all agents on one runner. `a2a-rs` ships only an in-memory
store, so this is our own implementation of its 5-method `TaskStore` trait on SQLite.

**Storage.** `tasks(id PRIMARY KEY, version, json)`: the whole A2A task as JSON, WAL mode, a single
connection behind a mutex. `update` refuses to change a terminal task, matching the in-memory store.

**Open questions.**
- Q-STORE-1 **Shared by all agents.** `ListTasks` on any agent returns every agent's tasks. Should
  the store filter by agent (an `agent` column), or use one store per agent?
- Q-STORE-2 **Retention.** Tasks are never deleted, and status history grows inside each task's
  JSON. What is the cleanup policy on the runner, and how does it interact with a Controller that
  was asleep and still wants a task's final snapshot?
- Q-STORE-3 **Event replay.** Catch-up is snapshot-only (`GetTask`); missed stream events are gone.
  That's fine while agents put everything that matters in artifacts (SPEC R4). Do we ever need real
  replay, e.g. for progress history? See SPEC §15.
- Q-STORE-4 **Other backends.** SPEC D3 calls for Postgres or a mounted volume for containers, and
  an external store for AgentCore. Is SQLite on local disk enough for every runner we plan?

### 3.10 Agents

**Role.** Programs that turn one input into results: any language, or a Docker command. The
contract is in [agents/README.md](agents/README.md). Python agents are single files with PEP 723
inline dependencies, run with `uv run`; `npm run build` pre-installs them with `uv sync --script`.

| Agent | Runner | Does | Depends on |
|---|---|---|---|
| `dadjokes` | ec2 | 5 jokes about a topic | Bedrock `us.openai.gpt-6.1-terra` |
| `sysreport` | laptop | CPU / memory / disk → summary | `sysinfo.sh`, Bedrock Haiku |
| `morningbrief` | laptop | Outlook inbox + calendar → brief, scheduled 07:30 | `aws-outlook-mcp` (aim/toolbox), Midway, Bedrock Haiku |
| `slow` | laptop | N progress steps; for disconnect tests | nothing |

**Open questions.**
- Q-AGENT-1 **Internal dependencies in an open-source repo.** `morningbrief` needs Amazon-internal
  tooling (`aws-outlook-mcp`, Midway, `~/.toolbox/bin`). pizza-bot is Apache-2.0 and published on
  GitHub. Does `morningbrief` stay in this repo, move to a private agents folder (pizza-bot already
  ignores `plugins-private/`), or get rewritten against a public mail API (e.g. pizza-bot's Google
  Workspace plugin)?
- Q-AGENT-2 **Credentials.** Agents inherit the runner's whole environment, so every agent sees
  every credential the runner has (AWS, Midway). Should each manifest declare the secrets it needs,
  with the runner passing only those?
- Q-AGENT-3 **What the contract can express.**
  - Input is one string and artifacts are text only.
  - There is no `input-required` event, no partial or streamed text, no files or binary artifacts,
    and no structured input schema.
  - Which of these come next? Approvals (Q-UI-5) need `input-required` in the contract first.
- Q-AGENT-4 **Isolation.** There's no sandbox beyond what the command does (a uv env, or Docker if
  the author chooses). Is it acceptable that an agent runs with the runner's user permissions? SPEC
  §11 compares the runner to the Docker socket.
- Q-AGENT-5 **Shipping agents.** EC2 agents ship as a tarball through S3. Is an agent a folder in
  this repo, a package, or a container image? Who owns versioning, and how does the Controller know
  which version ran?
- Q-AGENT-6 **Pizza-bot as an agent.** Could pizza-bot's own DeepAgents runtime be a fleet agent (a
  runner adapter, or an A2A endpoint on the api-server)? That would connect the two backends
  without shared code; see Q-FLEET-1.

### 3.11 Remote deployment and network

**As built.**
- One EC2 `t4g.small` (AL2023 arm64) with no inbound rules. The runner is a static musl binary under
  systemd, listening on 127.0.0.1:9000.
- The laptop reaches it through `deploy/tunnel.sh` (`ssh -L 127.0.0.1:9471:127.0.0.1:9000` over SSM,
  in a reconnect loop).
- Updates are manual: build the binary in Docker, upload it and the agents tarball to S3, then run
  `ec2-update.sh` on the box.
- Details in [docs/DEPLOY.md](docs/DEPLOY.md).
- `npm run dev` doesn't start the tunnel. The EC2 runner shows as unreachable unless you run
  `tunnel.sh` yourself.

**Open questions.**
- Q-NET-1 **Reachability.** SPEC §8 recommends a user-run overlay network (Tailscale or WireGuard)
  over per-runner tunnels. SSH-over-SSM is AWS-only and needs the AWS CLI, the session-manager
  plugin, and a key on the box. Which is the supported path for users, and who starts and supervises
  the tunnel (the Controller, the shell, or the user)?
- Q-NET-2 **TLS.** Runner traffic is plain HTTP with a static bearer token, safe only because it is
  localhost or inside a tunnel. What is required for a runner on a public host: TLS with the token,
  mTLS, or OAuth?
- Q-NET-3 **Provisioning.** Should creating a remote runner be part of the product (a script or
  template that launches the box, generates the token and registers it), or stay a documented manual
  step?
- Q-NET-4 **Account details in docs.** `docs/DEPLOY.md` names a specific AWS account id, instance id,
  bucket and security group. Fine for a personal experiment; remove them or replace them with
  placeholders before this branch goes anywhere public.

### 3.12 Security

**As built.**
- The Controller listens on 127.0.0.1 with a 0600 token file and a browser-origin allowlist.
- Runner tokens never leave the Controller (they're stripped from the public Model) but are stored
  in plain text in the Msg log.
- Runners require a bearer token on JSON-RPC; cards and the agent list are public.
- `morningbrief` wraps mail in `<emails>` / `<calendar>` tags and tells the model to treat it as
  untrusted. The Outlook MCP is read-only.

**Open questions.**
- Q-SEC-1 **Dev tokens.** `npm run dev` overwrites `~/.agent-fleet/token` with `fleet-dev-token`, and
  the laptop runner uses `localtoken`. Both are hardcoded in the repo, and the Fleet page defaults
  to the dev token. What replaces this for real installs (Q-UI-4)?
- Q-SEC-2 **Prompt injection.** It's mitigated only by tags and an instruction. With a read-only MCP
  the worst case is a misleading brief. What is the policy before any agent gets write tools (send
  mail, merge)? Is it human approval through `input-required`?
- Q-SEC-3 **Threat model for a shared Controller.** Today it is "one user, one laptop". Once phone
  access or a home-server Controller exists, who can send intents, and are intents audited (the
  Msg log is an audit trail, but has no user field)?

### 3.13 pizza-bot integration (boundary, build, dev)

**Boundary.**
- `apps/*`, `packages/*` and `plugins/*` never import `experimental/` or
  `@pizza-bot/fleet-controller`.
- The Controller imports no `@pizza-bot/*` package.
- Both directions are ESLint `no-restricted-imports` errors. The Fleet page talks HTTP/SSE only.

**Build.** `npm run build` = `turbo run build` (all pizza-bot packages + the Controller workspace) and
then `npm run fleet:build` (`cargo build --locked` for the runner + `uv sync --script` for each uv
agent). It needs Rust and uv on PATH.

**Dev.**
- `npm run dev`: Vite, Electron (which forks pizza-bot's api-server), the Controller and the laptop
  runner, rebuilding the runner incrementally on each start. On a fresh Controller it registers the
  `laptop` runner.
- `npm run dev:both`: the browser-only variant.
- `PIZZA_FLEET=0` skips the fleet, and a missing Rust toolchain skips it with a warning.
- `experimental/fleet/dev.sh` is the one command from a fresh clone: it checks prerequisites, runs
  `npm install` and `npm run build`, frees the ports, then runs `npm run dev` (the Electron app).

**Open questions.**
- Q-INT-1 **CI.** CI runs `npm run build` on Ubuntu and Windows. It now needs `uv` (not installed by
  the workflow) and Rust. On Windows the runner probably doesn't compile anyway (Q-RUN-1). Add
  `setup-uv` and skip the runner on Windows, make `fleet:build` optional in CI, or keep the fleet
  out of CI?
- Q-INT-3 **Packaging.** The desktop app ships the api-server as a sidecar. Would the packaged app
  ship the Controller and a local runner too (a Rust binary per platform, plus uv), or does the fleet
  stay dev-only?
- Q-INT-4 **Upstream.** pizza-bot-experimental tracks pizza-bot `main`. Is the fleet meant to go
  upstream eventually (then Q-AGENT-1, Q-NET-4 and Q-INT-1 block it), or stay in the experimental
  fork?

---

## 4. How the components work together

### One run

```
Fleet page ─CreateTask─▶ API (mints taskId) ─▶ log ─▶ update: task "dispatching", Effect Dispatch
runtime ─SendMessage(returnImmediately)─▶ runner ─▶ spawns agent, stores task (SQLite) ─▶ "working"
runtime ◀─ task snapshot ─ Dispatched ─▶ update: remoteId set ─▶ subscriptions: TaskStream wanted
runtime ─SubscribeToTask─▶ runner ─ status / artifact events ─▶ TaskUpdated ─▶ Model ─SSE─▶ Fleet page
agent exits 0 ─▶ runner: status completed ─▶ TaskUpdated (terminal) ─▶ subscription dropped, stream closed
   (if the stream ends before the final status: StreamDropped ─▶ GetTask ─▶ TaskSnapshot)
─▶ task shows in Inbox until AckInbox
```

### When something goes away

| Goes away | Keeps going | Recovery |
|---|---|---|
| Fleet page closed | everything | reopen; full Model on connect |
| Controller killed | runners and agents | replay log → `Booted` → re-check runners → `GetTask` open tasks |
| Controller killed mid-dispatch | the run may have started (Q-RT-1) | task marked `lost` |
| Network / tunnel | remote runner | health check fails → `unreachable` + backoff → `RunnerOk` re-fetches |
| Laptop sleeps | remote runners (local runner sleeps too) | Tick gap > 10 s → resync all |
| Runner restarts | finished tasks | in-flight tasks marked `failed` (Q-RUN-2) |
| Agent crashes | | task `failed` with the last stderr line |

All four POC pass criteria (SPEC §14a) were verified against both runners.

## 5. Questions about the fleet as a whole

- Q-FLEET-1 **What is the end state of the two backends?** The options:
  - **Coexist:** two products in one app, as today.
  - **Fleet becomes the execution layer:** pizza-bot's runtime runs as an agent on runners
    (Q-AGENT-6), and pizza-bot's inbox shows fleet results.
  - **Fleet stays a research spike:** it informs pizza-bot's design and is then dropped.

  The answer settles Q-UI-1, Q-SCHED-2, Q-RT-4 and Q-INT-3.
- Q-FLEET-2 **Where does the Controller run?** SPEC D5 allows the laptop by default, or an always-on
  home server or VM. An always-on Controller solves C3 for schedules (Q-SCHED-1) and catch-up
  latency, but needs remote UI access (Q-API-4) and real auth (Q-SEC-3). Which is the target?
- Q-FLEET-3 **Single user or shared?** Multi-user or shared fleets were "out of scope for v0"
  (SPEC §15). Confirm for v1, because it affects acked state, the audit trail, and auth.
- Q-FLEET-4 **What else connects to the Controller?** SPEC lists a CLI and an MCP shim, so other
  assistants could dispatch and watch tasks. The SPEC suggests the MCP shim may become the most-used
  UI. Is it next, and does it need the API contract (Q-API-1) first?
- Q-FLEET-5 **Observability.** Task-level state is in the Model. Trace-level (inside agents) is
  planned as OpenTelemetry (SPEC §12) but nothing emits traces. pizza-bot has its own logging
  package. Should fleet agents and the Controller emit to the same place?
- Q-FLEET-6 **Evals.** The Agents view has a disabled `[evals]` button. What would an agent eval be
  (replay past inputs, compare artifacts?), and does it belong in the Controller or in a runner?
