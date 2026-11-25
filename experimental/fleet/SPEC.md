# Agent Fleet: Spec v0

Status: draft, from design conversation on 2026-11-19.

Legend:
- ✅ verified against docs/sources (Nov 2026)
- 🔮 speculation or unverified assumption, test before relying on it

---

## 1. Problem

I want an app that orchestrates, observes, and controls agents.

- The app runs on my computer (laptop).
- It gives tasks to agents running somewhere else: a remote machine, AgentCore, or any other runtime.
- Agents report back.
- Agents must keep working while the laptop sleeps or is offline.
- It must work everywhere for any user. No dependency on a cloud service that I run.

## 2. Hard constraints

| # | Constraint |
|---|---|
| C1 | Runtime agnostic. AgentCore is one option, not the target. Remote boxes, containers, future runtimes must all fit. |
| C2 | No vendor cloud in the critical path. No central relay, mailbox, or broker operated by the project. |
| C3 | Laptop is never in the critical path. Agents finish work without it. |
| C4 | Controller is headless and fully decoupled from UI. A UI can be built in any language/framework. |
| C5 | UI and Controller follow The Elm Architecture (TEA). |
| C6 | Every piece must tolerate disconnects: laptop sleep, flaky network, runtime session recycling. |

## 3. Protocol landscape (context)

Three live protocols, three directions. They stack, they do not compete.

| Protocol | Direction | Role in this project |
|---|---|---|
| **MCP** (Model Context Protocol) | agent to tools/data | Agents use MCP for their own tools. Optional MCP shim exposes the Controller to other assistants. |
| **A2A** (Agent2Agent) | agent to agent | Backbone between Controller and Runners/remote agents. |
| **ACP** (Agent Client Protocol, Zed) | client/editor to agent | Runner uses it to drive local coding agents (Claude Code, Kiro, Gemini CLI) as subprocesses. |

Notes:
- ✅ "ACP" naming collision: IBM's Agent *Communication* Protocol merged into A2A in Aug 2025 and is no longer developed. Ignore it.
- ✅ A2A v1.0 (first stable spec) shipped March 2026. A2A and MCP are both under the Linux Foundation's Agentic AI Foundation.
- ✅ MCP 2026-07-28 spec made the core stateless (no protocol sessions, no `Mcp-Session-Id`, no initialize handshake).
- ✅ ACP is JSON-RPC 2.0 over stdio, agent runs as a subprocess of the client.

## 4. Architecture

```
            ┌──────────── UIs (any language) ────────────┐
            │  CLI   TUI   Web   Menubar   Mobile   MCP  │
            └──────────────────┬─────────────────────────┘
                               │ Controller API (HTTP + JSON, SSE)
                               │ TEA: Msgs in, Model patches out
┌──────────────────────────────▼─────────────────────────────┐
│ CONTROLLER (headless daemon, laptop by default)            │
│  - Model / update / effects / subscriptions (TEA runtime)  │
│  - Msg log + snapshots (SQLite)                            │
│  - A2A client adapter (others pluggable)                   │
└──────────────────────────────┬─────────────────────────────┘
                               │ A2A over HTTPS (user's network)
         ┌─────────────────────┼──────────────────────┐
         ▼                     ▼                      ▼
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ RUNNER          │  │ AgentCore        │  │ Any A2A endpoint │
│ (remote box)    │  │ A2A agent        │  │                  │
│ A2A server (SDK)│  │ task store OUT-  │  │                  │
│ SQLite tasks    │  │ SIDE the microVM │  │                  │
│ adapters:       │  │ (user's account) │  │                  │
│  Strands, ACP,  │  └──────────────────┘  └──────────────────┘
│  scripts        │
└─────────────────┘
```

Three components:
1. **Controller**: headless daemon, source of truth for the user's view of the fleet.
2. **UIs**: thin views over the Controller API.
3. **Runner**: lightweight install on remote machines. An A2A server that wraps agents that do not speak A2A.

Same shape as dockerd + docker CLI, and GitHub Actions self-hosted runners.

## 5. Key decisions

### D1. A2A is the Controller to agent protocol
- Unit of work is a Task with lifecycle states, streaming updates, artifacts, cancel, and `input-required` for approvals.
- Agent Cards give discovery (what can this agent do).
- One code path in the Controller for every runtime.

### D2. The A2A server is the mailbox
- No separate cloud mailbox. The A2A server owns the task: status, history, artifacts.
- The mailbox lives with the agent, not with the user.
- Laptop sleeps, agent keeps writing to its own task store, laptop catches up on wake.

### D3. Task store must outlive the agent process
| Where agent runs | Task store |
|---|---|
| Remote box / VM | SQLite file on disk |
| Docker / K8s | Mounted volume or Postgres, never container-local disk |
| AgentCore | Outside the microVM, in the user's own AWS account (RDS Postgres or custom DynamoDB store) |

### D4. Do not hand-roll A2A
- ✅ Official Python SDK (`a2a-sdk`) provides protocol handling, routing, and task stores (in-memory and SQLAlchemy `DatabaseTaskStore`).
- ✅ Strands wraps an agent as an A2A server in about 10 lines (`StrandsA2AExecutor` + `serve_a2a`).
- Per agent you write only the executor glue: receive task, run agent, emit progress.
- What we build: the **Runner** (A2A server + adapters for non-A2A agents, incl. ACP bridge to coding agents).

### D5. Controller is headless with a stable API contract
- Rules:
  1. UI never sees A2A. Controller maps to its own domain model (Runner, Agent, Task, Artifact). A2A ids kept as metadata.
  2. Everything is a logged, sequenced change.
  3. Commands in, state changes out. UIs never mutate directly.
  4. API contract (OpenAPI + Msg/Model schema) is the product. Generate clients.
- Transport: HTTP + JSON, server-to-UI updates over SSE (`Last-Event-ID` gives free resume). WebSocket only if truly needed.
- Controller can run anywhere: laptop by default, or an always-on home server/VM for power users (solves most sleep issues for them).

### D6. UI and Controller follow TEA
| TEA piece | In this system | Lives in |
|---|---|---|
| Model | Runners, agents, tasks, approvals, connection health | Controller |
| Msg | User intent (`CreateTask`, `Cancel`, `Respond`, `AddRunner`) and world results (`TaskUpdated`, `TaskSnapshot`, `StreamDropped`, `RunnerUnreachable`, `Tick`) | UIs send intent Msgs, runtime produces world Msgs |
| update | `(Model, Msg) -> (Model, [Effect])`, pure | Controller |
| Effect | A2A send/get/cancel/resubscribe, fetch artifact, timers | Controller runtime executes |
| Subscriptions | `subscriptions(Model) -> Set[Sub]` (which A2A streams to hold open, which runners to health check) | Controller runtime reconciles |
| view | Render the Model | Each UI |

TEA rules:
1. `update` is pure. Time arrives as `Tick(now)`, ids generated by runtime and passed in Msgs.
2. Log every Msg including world results. Replay rebuilds the exact Model. On replay, drop effects, never re-execute.
3. Single update loop, one queue, no locks. Effects run concurrently, results re-enter as Msgs.
4. Two kinds of state: shared **app model** (Controller) and local **UI model** (each UI: selection, scroll, drafts).
5. Model stays lean: metadata and references, not artifact blobs.
6. Version Msg types. Snapshot periodically so old formats can be retired.

Big win: reconnect is not a routine, it falls out of subscription reconciliation. Model says a stream should be open, runtime opens it. Stream drops, `update` handles `StreamDropped`, marks runner stale, schedules `GetTask` + backoff. Snapshot arrives, runner reachable again, subscription comes back, runtime reopens it. Same pattern as Kubernetes controllers.

## 6. Controller API (first cut)

```
POST /msg            {msg_id, type, payload}  -> 202 {accepted_at_version}
GET  /model          -> {version, model}
GET  /model/stream   SSE: {from, to, patch}   (JSON Patch, RFC 6902)
GET  /artifacts/{id} -> blob
```

- UIs may only send intent Msgs. World Msgs over the API are rejected.
- `msg_id` gives idempotency (duplicate sends are no-ops).
- Patches are versioned. UI applies a patch only if `from == my_version`, otherwise refetches `/model`.
- Validation errors go into the Model (e.g. `model.notifications`) so every UI sees them.
- 🔮 At personal scale the full Model is likely tens of KB. v1 could ship the whole Model on each change and skip patches. Profile first.

## 7. Disconnect and sleep handling

### Agent side (laptop not needed)
1. Dispatch is non-blocking. Agent acks with a task id and continues.
2. Agent persists state durably (D3).
3. Important information goes into task history/artifacts, not only the live stream.
4. Agent waiting for approval saves state and may let its session end. Resumes on response.
5. Agent to agent calls go direct (agent acts as A2A client). Laptop not involved.

### Controller side (on wake, expressed as TEA update cases)
For each non-terminal task:
1. `GetTask` and diff against the local Model.
2. Pull new artifacts by reference.
3. Still running: subscription re-opens the stream.
4. Runner not responding: mark `unreachable`, retry with backoff. Never assume dead.

### Caveat
- 🔮 Catch-up via get-task returns a **snapshot**, not a replay of missed stream events. Design so the snapshot always tells the full story.
- 🔮 `a2a-sdk` 1.3.x has a `cluster` module with `VersionedDatabaseTaskStore` and a DB-backed event stream. Might give real event replay. Not verified, read the code.

### Push notifications
Optional only. Users can plug in their own webhook (ntfy, Slack, etc.) for "needs approval" alerts. Never the core path.

## 8. Network reachability

The Controller must reach Runners when it wakes. Runners may be behind NAT.

- Recommended: user's own overlay network (Tailscale / WireGuard). Document it, do not build it.
- Runner on public host: HTTPS + token.
- AgentCore: public endpoint with OAuth 2.0 or SigV4.
- Never make the Runner dial the laptop. The laptop is the side that sleeps.

## 9. Runtime notes

### AgentCore (✅ verified unless marked)
- A2A container serves stateless streamable HTTP on port 9000 at `/`. AgentCore proxies JSON-RPC unchanged, adds auth (SigV4 / OAuth 2.0) and per-session isolation.
- Agent Card at `/.well-known/agent-card.json`.
- Idle session terminated after 15 min by default (`idleRuntimeSessionTimeout`, default 900s).
- Long work: `/ping` must return `HealthyBusy`. SDK `add_async_task` / `complete_async_task` manages it.
- Do not advance `time_of_last_update` on every ping: idle timeout never fires, sessions live to MaxLifetime and can exhaust quota.
- MaxLifetime: up to 8h on microVM runtimes, up to 14 days on capacity-provider (instance) runtimes.
- Controller must persist the runtime session id per task and reuse it.
- Auth type in client must match the runtime's configured authorizer or you get 403s.
- AgentCore A2A guide pins `a2a-sdk ~0.3.x` and `message/send`, while spec is at v1.0 and SDK at 1.3.x. Build against what AgentCore actually serves.
- 🔮 Open SDK issue (#471) claims sessions get reaped despite `HealthyBusy` when `time_of_last_update` is missing. Contradicts docs. Test it.

### Remote box
- Runner as a system service (systemd / launchd).
- SQLite or Postgres task store.
- Only inbound reachability needed is for the Controller (via overlay network or public HTTPS).

### Anything else
- Fits if it implements the Runner contract (section 10) directly or via an adapter.

## 10. Runner / agent contract

Any agent joining the fleet must:

| # | Requirement | Why |
|---|---|---|
| R1 | Speak A2A (natively or through a Runner adapter) | One Controller code path |
| R2 | Accept non-blocking sends | Controller can disconnect right after dispatch |
| R3 | Persist task state durably outside the agent process | Survives restarts and session recycling |
| R4 | Record important progress in task history / artifacts | Snapshot catch-up stays complete |
| R5 | Write large results as artifacts by reference | Big outputs survive, Model stays lean |
| R6 | Save state before entering `input-required` | Approvals can take hours |
| R7 | Tasks are idempotent / safe to retry | Resend after "lost" does no harm |

## 11. Security

- Controller API binds to Unix socket or `127.0.0.1` by default.
- [REDACTED_TOKEN] in a 0600 file (Jupyter style). UIs read it.
- Lock CORS so random websites cannot drive the fleet via localhost.
- Remote UI access (phone) is opt-in, over the user's overlay network only.
- Runner endpoints require auth (token / OAuth). Treat it like the Docker socket: it launches agents.
- Optional webhook pushes must be signed and verified.

## 12. Observability

- Task level (A2A): state, streamed status, artifacts, cancel. Feeds the UI.
- Trace level (inside the agent): A2A hides it on purpose. Use OpenTelemetry (AgentCore Observability / CloudWatch, or any OTel backend).
- Msg log gives Controller-level time-travel debugging.

## 13. Testing

- `update` is pure, so tests are tables: given Model, when Msg, then Model + Effects.
- Simulate laptop sleep, runner crash, duplicate events, out-of-order snapshots without a network.
- Replay real Msg logs from the field through the same tests.

## 14. Build order

1. Controller core: Model / Msg / Effect / Sub types, pure `update`, Msg log.
2. A2A client adapter + runtime (effect executor, subscription reconciler).
3. Controller API (HTTP + SSE) and the spec (OpenAPI + schemas).
4. CLI client (cheapest UI, proves the API).
5. Runner v0: `a2a-sdk` server, SQLite store, one Strands agent.
6. End to end test: dispatch, close the laptop lid, wake, verify catch-up.
7. AgentCore adapter: HealthyBusy, session id persistence, external task store.
8. Approvals: `input-required`, save and resume.
9. Runner ACP bridge for Claude Code / Kiro.
10. MCP shim over the Controller API.
11. Real UI(s).

## 14a. POC

Goal: prove the core loop works, not build the product. Gaps deliberately skipped are tracked in `POC-GAPS.md`.

Scope:
- 1 Controller on the laptop.
- 2 Runners: one local (laptop), one remote (EC2).
- 1 UI: the Fleet page in pizza-bot's web app (`docs/UI.md`). (A TUI was built first and dropped when the fleet moved into pizza-bot-experimental.)

Stack:
- Controller: Node 24 + TypeScript in the pizza-bot npm workspace (Hono, better-sqlite3 Msg log), `@a2a-js/sdk` client (A2A v1.0, JSON-RPC binding). Built on Bun first, ported to Node to join the monorepo.
- Runner: Rust, official `a2a-rs` SDK (`a2a-lf`, `a2a-server-lf`), SQLite task store (`rusqlite`), single static binary.
- Remote: EC2 instance, Runner on 127.0.0.1, reached over SSH-over-SSM tunnel (no inbound ports), bearer token. See `docs/DEPLOY.md`.

Agents (runner picks one with `RUNNER_AGENT`):
- `dadjokes` on EC2: input is a topic, Bedrock `us.openai.gpt-6.1-terra` writes 5 jokes. Uses the instance role.
- `sysreport` on the laptop: `runner/scripts/sysinfo.sh` collects load, CPU, memory and disk, then Bedrock `us.anthropic.claude-haiku-5-5` summarizes it. Input is an optional focus question. Uses local AWS credentials.
- `fake`: prompt `steps=N every=S <text>`, no LLM. Kept for disconnect tests.

Pass criteria:
1. Dispatch a task to each Runner from a UI. Both show live progress.
2. Kill the Controller (or sleep the laptop) mid-task. Runners keep going.
3. Restart the Controller (or wake). Both tasks catch up to the correct state and artifact without user action.
4. Stop a Runner mid-task. Controller marks it `unreachable`, retries with backoff, recovers when the Runner returns.

Result (2026-11-19): all four pass, against the local runner and the EC2 runner. Verified facts and
gotchas are in `docs/LEARNINGS.md`.

## 15. Open questions

- Event replay: is snapshot catch-up enough, or do we need the SDK's cluster event stream (or our own)?
- Patches vs full Model over SSE for v1.
- AgentCore task store: RDS Postgres via existing SQLAlchemy store vs custom DynamoDB store.
- Runner adapter plugin model: in-process plugins vs subprocess adapters.
- Msg schema versioning and snapshot cadence.
- Multi-user / shared fleets: out of scope for v0?

## 16. Ideas parked

- 🔮 The MCP shim may become the most-used "UI": people may prefer their main assistant to dispatch and watch tasks over yet another dashboard.
- 🔮 MCP's Multi Round-Trip Requests and handle-based state blur the "agent as MCP tool" vs A2A line. Likely: MCP-wrapped agents for internal, A2A for crossing org/vendor boundaries.
- 🔮 An MCP gateway, so every agent can use every MCP server: built-in agents, plugin agents (Python, Docker, Claude Code, AgentCore) and agents on any runner, instead of each runner configuring its own servers for its built-in agents only.
- 🔮 Memory as a plugin behind that gateway: agents reach memory as MCP tools, so the memory implementation can be swapped without changing the agents.
- 🔮 Rewrite the Controller in Rust, like the runner.

## 17. References

- A2A spec: https://a2a-protocol.org
- A2A streaming & async: https://a2a-protocol.org/latest/topics/streaming-and-async/
- a2a-python SDK: https://github.com/a2aproject/a2a-python
- DatabaseTaskStore: https://a2a-protocol.org/latest/sdk/python/api/a2a.server.tasks.database_task_store.html
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- ACP (Agent Client Protocol): https://zed.dev/acp
- ACP merged into A2A: https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/
- AgentCore A2A: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html
- AgentCore long running: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html
- AgentCore lifecycle settings: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html
- SDK issue #471: https://github.com/aws/bedrock-agentcore-sdk-python/issues/471
