# Fleet (experimental backend)

The second backend inside pizza-bot-experimental. A headless **Controller** on the laptop talks to
**Runners** over A2A; runners host **agents** (folders in `agents/`) on the laptop and on EC2. The
**Fleet** page in pizza-bot's web app (`apps/web/src/components/fleet/`) is a view of the Controller.
It runs next to pizza-bot's own api-server; the two share nothing but the web app.

Agents keep working while the laptop sleeps or the Controller is down; the Controller catches up when
it comes back.

- Design and decisions: [SPEC.md](SPEC.md) (section 14a is the POC scope)
- Components as built, with open questions: [DESIGN.md](DESIGN.md)
- What the POC skips: [POC-GAPS.md](POC-GAPS.md)
- Agent contract: [agents/README.md](agents/README.md)
- EC2 and AWS details: [docs/DEPLOY.md](docs/DEPLOY.md)
- The Fleet page: [docs/UI.md](docs/UI.md)
- Verified facts and gotchas: [docs/LEARNINGS.md](docs/LEARNINGS.md)

## Getting started

The experiment lives on the `experimental/distributed-backend` branch of the
[igorfil/pizza-bot](https://github.com/igorfil/pizza-bot) fork.

```bash
git clone --branch experimental/distributed-backend https://github.com/igorfil/pizza-bot.git pizza-bot-experimental
cd pizza-bot-experimental
experimental/fleet/dev.sh
```

`dev.sh` goes from source to the running app in one go:

1. **Checks prerequisites** and stops with install commands for anything missing: Node.js 24+, Rust
   (`cargo`, `rustup`), `uv`, `lsof`, `zig`, the AWS CLI, `session-manager-plugin` and working AWS
   credentials (the Controller reaches EC2 over SSM; agents call Bedrock). It installs what it can
   without asking: `zig` (with Homebrew), `cargo-zigbuild`, and the `aarch64`/`x86_64-unknown-linux-musl`
   Rust targets.
2. Runs **`npm install`**.
3. Runs **`npm run build`**: pizza-bot, the fleet Controller, the runner, its **arm64 and x86_64 Linux
   builds for EC2** and the agents' Python environments. It stops if either Linux build is missing.
4. **Frees the ports** it needs (5273, 7700, 9301), stopping whatever listens on them.
5. Starts **`npm run dev`**: the pizza-bot desktop app (Electron, with its UI from Vite on :5273; open
   **Fleet** in the left rail), the Controller on :7700 and the laptop runner on :9301, which is
   registered on a fresh Controller. Ctrl-C stops everything.

Then **Agents → Add runner → AWS EC2** puts a runner on one of your instances, and **Add agent** on a
runner creates or turns on agents.

Already-cloned and built, from the repo root:

```bash
npm install && npm run build      # once
npm run dev                       # pizza-bot (Vite :5273 + Electron) and the fleet: Controller :7700,
                                  # laptop runner :9301. Open Fleet in the rail.
npm run dev:both                  # browser-only: api-server :8080 + the fleet + web :5173
```

Both start the fleet through `scripts/fleet-dev.mjs`: it writes the fixed dev token
`fleet-dev-token` to `~/.agent-fleet/token` (the Fleet page's default), builds the runner with cargo
the first time, and allows the web origins `:5273` and `:5173`. `PIZZA_FLEET=0` skips the fleet;
without a Rust toolchain it is skipped with a warning. On a fresh Controller it registers the
`laptop` runner. The EC2 runner isn't started; run `deploy/tunnel.sh <instance-id>` and add it by hand.
Ctrl-C stops everything.


First run only: register the runners (the Controller remembers them in its Msg log). On the Fleet
page use **Agents → Add runner**, or:

```bash
H="authorization: Bearer fleet-dev-token"
curl -X POST localhost:7700/msg -H "$H" -d '{"msg_id":"r1","type":"AddRunner","payload":{"name":"laptop","url":"http://127.0.0.1:9301","token":"localtoken"}}'
curl -X POST localhost:7700/msg -H "$H" -d '{"msg_id":"r2","type":"AddRunner","payload":{"name":"ec2","url":"http://127.0.0.1:9471","token":"<EC2 runner token>"}}'
```

`transport` is `{kind: "direct", url}`, `{kind: "ssh", host, user?, port?, identityFile?, remotePort?}`
or `{kind: "aws_ssm", region, instanceId, remotePort?, credentials?}` (`remotePort` defaults to 9000;
`credentials` is `{kind: "default"}` or `{kind: "profile", profile}`). `ssh` runs the system `ssh -N -L`
in batch mode, so auth comes from `~/.ssh/config`, ssh-agent and `known_hosts`; the host key must
already be known. Tokens go to the OS vault; the Msg log keeps only the key.

```bash
curl -X POST localhost:7700/msg -H "$H" -d '{"msg_id":"r3","type":"AddRunner","payload":{"name":"homelab","token":"<token>","transport":{"kind":"ssh","host":"homelab","user":"me"}}}'
```

## Boundary with pizza-bot

- Nothing under `apps/` or `packages/` imports `experimental/`, and the Controller imports no
  `@pizza-bot/*` package. ESLint enforces both (`no-restricted-imports` in `eslint.config.js`).
- The Fleet page talks to the Controller over HTTP/SSE only (`fleet-client.ts`).
- The Controller is an npm workspace (`@pizza-bot/fleet-controller`), so `npm run build`,
  `typecheck`, `lint` and `test` cover it. The runner (Rust) and agents (Python) are outside npm.

## The system

```
╔════════════════════════════════════ YOUR LAPTOP ════════════════════════════════════╗
║                                                                                     ║
║  ┌─ Fleet page (apps/web) ────────┐          ┌─ CONTROLLER ── process (daemon) ───┐ ║
║  │  local UI state only:          │  intent  │  controller/  127.0.0.1:7700       │ ║
║  │   selection, input, mode       │  Msgs    │                                    │ ║
║  │                                │ ───────▶ │  TEA: Msg → update → Model+Effects │ ║
║  │  view(Model) → screen          │ POST /msg│  Msg log: ~/.agent-fleet/          │ ║
║  │                                │          │           controller.db            │ ║
║  │  start/quit anytime;           │ ◀─────── │  ticks 2s · health checks 15s      │ ║
║  │  any number of UIs can attach  │  Model   │  runs with or without a UI         │ ║
║  └────────────────────────────────┘  SSE     └──────┬──────────────────────┬──────┘ ║
║                                                     │ A2A                  │ A2A    ║
║                                                     ▼                      ▼        ║
║  ┌─ RUNNER "laptop" ── process ────────────────────────────┐   ┌─ tunnel.sh ─────┐  ║
║  │  127.0.0.1:9301 · auth · task store (SQLite) · /agents  │   │ 127.0.0.1:9471  │  ║
║  │  one subprocess per run (agents/README.md)              │   │ ssh -L → :9000  │  ║
║  │  built-in engine: apps/fleet-agent                      │   │ auto-reconnect  │  ║
║  │  /agents/webresearch   agents/webresearch (built-in)    │   └────────┬────────┘  ║
║  │  /agents/<created>     created-agents/<id> (built-in)   │            │           ║
║  └─────────────────────────────────────────────────────────┘            │           ║
╚═════════════════════════════════════════════════════════════════════════┼═══════════╝
                                                                          │ SSH over SSM
╔═════════════════════════════════════ AWS EC2 ════════════════════════════┼═══════════╗
║  ┌─ RUNNER "ec2" ── systemd service ──────────────────────────────────────▼────────┐ ║
║  │  127.0.0.1:9000 · auth · task store (SQLite) · GET /agents                       │ ║
║  │  built-in engine: /opt/fleet-engine (Node + apps/fleet-agent)                    │ ║
║  │  /agents/<created>     /var/lib/fleet-runner/created-agents/<id> (built-in)      │ ║
║  └─────────────────────────────────────────────────────────────────────────────────┘ ║
║  security group: no inbound · IAM role: SSM, S3 read, invoke terra                   ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
```

The Controller always dials out. Runners never call the laptop, because the laptop is the side that
sleeps.

| Process | Holds | Can die without losing work? |
|---|---|---|
| Fleet page | Screen state only | Yes. Reopen and it reloads the Model. |
| Controller | Fleet view: runners, runs, results (Msg log) | Yes. Replays its log and catches up from runners. |
| Runner | Real task state for all its agents (one SQLite) | Finished runs are safe; an in-flight run is marked `failed`. |
| Agent | Nothing durable; a subprocess per run | Its run fails; the runner reports why. |

### One run, start to finish

```
UI ──"coffee"──▶ Controller ──SendMessage (returnImmediately)──▶ ec2 runner
                     │◀────────── task id, state: working ─────────┤
                     │                                             ├──▶ Bedrock (terra)
                     │◀──── stream: status · jokes · completed ────┤◀── 5 jokes
UI ◀── Model update ─┤
```

If the laptop goes away at any point, the runner finishes and stores the result. When the Controller
comes back it re-checks runners and re-fetches open runs.

### What happens when something goes away

| Goes away | Keeps going | Recovery |
|---|---|---|
| UI closed | Everything | Reopen; shows the current Model |
| Controller killed | Runners, writing to their SQLite | Replays Msg log, `Booted` → re-checks runners → `GetTask` for open runs |
| Tunnel or network drops | EC2 runner | `tunnel.sh` reconnects; health check turns green; open runs re-fetched |
| Laptop sleeps | EC2 runner (local ones sleep too) | Tick gap > 10s = wake → runners set to `unknown` → re-check → re-fetch |
| Runner restarts mid-run | Finished runs in its SQLite | The in-flight run is marked `failed` (POC gap) |

## Layout

```
experimental/fleet/
├── SPEC.md · POC-GAPS.md · README.md
├── dev.sh                 from a fresh clone to the running app: prerequisites, install, build, run
├── agents/                one folder per agent: agent.toml + code (README.md = the contract)
├── docs/                  DEPLOY.md · LEARNINGS.md · UI.md
├── controller/            Node 24 + TypeScript, npm workspace @pizza-bot/fleet-controller
│   ├── src/types.ts       Model, Msg (intent + world), Effect, Sub
│   ├── src/update.ts      pure update + subscriptions; all timing constants
│   ├── src/runtime.ts     single update loop, effect executor, stream reconciler
│   ├── src/a2a.ts         the only file that knows A2A (@a2a-js/sdk)
│   ├── src/chat.ts        pure chat transitions + system prompt
│   ├── src/llm.ts         Bedrock Converse for chat (@aws-sdk/client-bedrock-runtime)
│   ├── src/api.ts         HTTP + SSE API on Hono (@hono/node-server), auth, browser-origin allowlist
│   ├── src/log.ts         SQLite Msg log (better-sqlite3)
│   └── src/*.test.ts      update() table tests, API tests (Vitest)
├── runner/                Rust, official a2a-rs SDK
│   ├── src/main.rs        config, routes per agent, agent cards, GET /agents, bearer auth
│   ├── src/manifest.rs    agents/<id>/agent.toml loader
│   ├── src/exec.rs        runs an agent as a subprocess: stdin input, JSON-line events, cancel, timeout
│   ├── src/store.rs       SQLite TaskStore shared by all agents (a2a-rs ships only in-memory)
│   └── src/events.rs      A2A status/artifact event helpers
└── deploy/                user-data.sh (EC2 bootstrap) · ec2-update.sh · tunnel.sh (SSH over SSM)
```

## Controller

### API

All endpoints need `Authorization: Bearer <token from ~/.agent-fleet/token>`. Bound to 127.0.0.1.

| Endpoint | Purpose |
|---|---|
| `POST /msg {msg_id, type, payload}` | Send an intent. `202 {accepted_at_version}`; a repeated `msg_id` is a no-op (`200, duplicate: true`). |
| `GET /model` | `{version, model}` |
| `GET /model/stream` | SSE. Each event is the full `{version, model}`, sent on every change except quiet Ticks (UIs run their own clock); keepalive comment every 15s. |

Intents (only these are accepted over the API; world Msgs are rejected):

| type | payload |
|---|---|
| `AddRunner` | `name, token`, and `url` (direct) or `transport` (below) |
| `AddAgents` | `runner`, `agents` (ids from the runner's `available`); the runner starts serving them |
| `DeleteAgent` | `agent` (`<runner>/<id>`); a created agent is deleted from its runner, a shipped one turned off. Refused while it has a run in progress |
| `CreateAgent` | `runner`, `name`, `model` (one of the model's `agentModels`), `systemPrompt`; the runner creates and serves a prompt agent |
| `EditAgent` | `agent` (`<runner>/<id>`), `name`, `model`, `systemPrompt`; rewrites a created agent under the same id. Runs in progress finish with the old spec |
| `UpdateRunner` | `name`, plus any of `url`/`transport`, `token`; the link reopens with the new config |
| `RemoveRunner` | `name` |
| `RenameRunner` | `name`, `label` (display name, up to 40 characters; empty = back to `name`). The id `name` and agent keys don't change |
| `CreateTask` | `agent` (`<runner>/<id>`), `prompt` (may be empty) |
| `CancelTask` | `taskId` |
| `AckInbox` | `taskId`: mark a finished run as dealt with |
| `AckAllInbox` | none |
| `CreateChat` | `text` (optional first message), `fromTaskId` (optional: start from an agent result) |
| `SendChatMessage` | `chatId, text` |
| `SetSchedule` | `agent` (`<runner>/<id>`), `at` (`HH:MM`, empty = off), `prompt` (optional input for scheduled runs) |

`POST /msg` returns the id it minted (`id`, for `CreateTask` and `CreateChat`) so a UI can open what
it just created.

### Inbox and chat

- **Inbox** = finished runs (`completed`, `failed`, `canceled`, `rejected`, `lost`) whose `ackedAt` is
  null, newest first (`inboxOf` in `update.ts`). No separate inbox store; acknowledging sets
  `Task.ackedAt`. Runs from before this feature have no `ackedAt` and show up as unread once.
- **Chat** lives in the Controller Model (`Model.chats`) and Msg log, so every UI sees the same chats.
  `CreateChat`/`SendChatMessage` append the user message, set `pending`, and emit a `ChatComplete`
  effect; `llm.ts` calls Bedrock Converse (`FLEET_CHAT_MODEL`, default
  `us.anthropic.claude-haiku-5-5`, region `AWS_REGION` or us-west-2, local AWS credentials) and
  the result comes back as `ChatReplied` / `ChatFailed`. A chat started from a run gets the run
  (agent, input, outcome, artifacts) in the system prompt (`chat.ts`). Message ids derive from
  position so replay reproduces them. A reply in flight when the Controller dies is marked failed on
  `Booted`; send again.
- **Runners and agents**: the health check reads the runner's `GET /agents` and replaces that
  runner's agents in the Model (keeping their schedules); `RUNNER_LOCATION` becomes
  `Runner.location`. Every A2A call goes to `<runner url>/agents/<id>`.

The Controller mints ids (task ids) before `update` sees a Msg, so `update` stays pure and replayable.
Runner tokens never leave the Controller (`publicModel` strips them).

Browsers always send `Origin`. Requests with an Origin are refused unless it is listed in
`FLEET_ALLOWED_ORIGINS`; allowed origins also get CORS headers and preflight replies.

### TEA (The Elm Architecture)

```
Msg ──▶ update(Model, Msg) ──▶ (Model, [Effect])        pure; time arrives as Tick(now)
              │                       └──▶ runtime runs effects; results come back as Msgs
              └──▶ subscriptions(Model) ──▶ which task streams to hold open (runtime reconciles)
```

- World Msgs: `Booted, Tick, RunnerOk, RunnerFailed, Dispatched, DispatchFailed, TaskSnapshot,
  TaskUpdated, SyncFailed, StreamDropped, CancelFailed, ChatReplied, ChatFailed`.
- Effects: `CheckRunner` (fetch agent card), `Dispatch` (SendMessage, returnImmediately),
  `GetTask`, `Cancel`, `ChatComplete` (Bedrock).
- Sub: `TaskStream` keyed `taskId#epoch`. Bumping the epoch forces a reconnect.
- Every Msg is logged before its effects run, except quiet Ticks (no effects, nothing changed but
  the clock): the latest one is held back and logged just before the next Msg, and each Tick
  carries `since` (the Model's `now` when it was sent) so wake detection replays exactly. On start
  the log is replayed with effects dropped, then `Booted` is dispatched.

Timing constants (`controller/src/update.ts`): tick 2s, health check 15s, backoff `2^(n-1)` s capped
at 30s, resync of open runs every 30s, a tick gap over 10s counts as wake.

### Config

| Env | Default | |
|---|---|---|
| `FLEET_HOME` | `~/.agent-fleet` | token file + `controller.db` |
| `FLEET_PORT` | `7700` | |
| `FLEET_ALLOWED_ORIGINS` | none | comma list of browser origins, e.g. `http://localhost:5173` |
| `FLEET_CHAT_MODEL` | `us.anthropic.claude-haiku-5-5` | Bedrock model for chat |
| `AWS_REGION` | `us-west-2` | Bedrock region for chat; credentials from the default AWS chain |

## Runner

A generic host: one process per machine, serving agent folders from `RUNNER_AGENTS_DIR`. It knows
nothing about what agents do. Agents are separate programs (any language, or Docker); the contract
is in [agents/README.md](agents/README.md): JSON on stdin, JSON-line events on stdout, exit code.

| Env | Default | |
|---|---|---|
| `RUNNER_TOKEN` | required | bearer token the Controller must send |
| `RUNNER_AGENTS_DIR` | `agents` | folder of agent folders |
| `RUNNER_AGENTS` | all | comma list of agent ids to serve at first start (an unknown id is a startup error); once the Controller sets them with `PUT /agents`, that saved list wins |
| `RUNNER_BIND` | `127.0.0.1:9000` | |
| `RUNNER_PUBLIC_URL` | `http://$RUNNER_BIND` | base URL agent cards advertise; must be the URL the Controller uses |
| `RUNNER_DB` | `runner.db` | SQLite task store, shared by all its agents |
| `RUNNER_CREATED_AGENTS_DIR` | `created-agents` next to `RUNNER_DB` | agents made with `POST /agents`; kept outside `RUNNER_AGENTS_DIR`, which an upgrade replaces |
| `RUNNER_NAME` | `runner` | runner name in `GET /agents` |
| `RUNNER_LOCATION` | none | where it runs ("this laptop", "EC2 us-west-2"); in `GET /agents` and card `provider.organization` |

Agents inherit the runner's environment (so `PATH`, AWS credentials), plus their manifest's `[env]`.

Endpoints:
- `GET /agents`: public; `{runner, location, agents: [...], available: [...]}`, each entry
  `{id, name, description, input, url}`. `agents` are served; `available` are on disk but off. The
  Controller uses it for discovery and as the runner health check.
- `POST /agents`: bearer token required; `{name, model, systemPrompt}` writes an agent for the
  built-in engine (`agent.toml`, `system.md`, `skills/`) into `RUNNER_CREATED_AGENTS_DIR`, serves it
  at once, and answers with the new index plus `created: <id>`. The index's `canCreate` says the
  runner has the engine (`RUNNER_HARNESS_PIZZA_BOT`); without it the request answers 409.
- `PUT /agents/<id>`: bearer token required; `{name, model, systemPrompt}` rewrites a created agent
  in place (same id, so its URL and runs stay) and answers with the new index. Shipped agents
  answer 409. Created agents' index entries carry `model` and `systemPrompt` for editing.
- `DELETE /agents/<id>`: bearer token required; deletes a created agent's folder, or turns a
  shipped agent off (it stays in `available`), and answers with the new index. Each index entry's
  `created` tells the two apart.
- `PUT /agents`: bearer token required; `{agents: [ids]}` replaces the served set, saves it in
  `RUNNER_DB` so it survives restarts, and answers with the new index. Unserved agents answer 404.
- `/agents/<id>/.well-known/agent-card.json`: public A2A agent card per agent. Its one skill carries
  the input label (`name`), hint (`description`) and default input (`examples[0]`).
- `/agents/<id>/jsonrpc`: A2A v1.0 JSON-RPC, bearer token required.

Agents in this repo (details in [agents/README.md](agents/README.md)):

| Agent | Kind | Input | Does | Artifacts |
|---|---|---|---|---|
| `webresearch` | built-in | question | reads the pages it fetches (fetch MCP) and answers from them | `reply` |

Everything else is created on the Fleet page and runs on the runner's built-in engine.

Build: `cd runner && cargo build`. Linux binary and EC2 update: [docs/DEPLOY.md](docs/DEPLOY.md).

### Daily schedule

The Controller can run any agent once a day: `SetSchedule {agent: "<runner>/<id>", at: "HH:MM",
prompt}` (empty `at` turns it off). Each Tick carries the local calendar position (`local: {day,
minute}`, computed by the runtime so `update` stays pure). An agent with a schedule fires on the
first Tick at or after `at` whose local day differs from `lastScheduledDay`, so a laptop that slept
through 07:30 runs the brief as soon as it wakes. The task id is `schedule:<runner>/<id>:<day>` (one
per day, replay-safe) and the task has `trigger: "schedule"`. Setting a time that has already passed
today waits for tomorrow. Schedules live on the Controller's `Agent` and survive the runner
re-reporting its agents.

## Testing

```bash
npm test -w @pizza-bot/fleet-controller                 # from the repo root: update() + API tests
npm run typecheck -w @pizza-bot/fleet-controller
cd experimental/fleet/runner && cargo test
```

### Reconnect scenarios

The real agents finish in seconds. Mid-run tests need an agent that runs for a while.

1. **Close the UI**: start a run, quit, reopen. The result is there.
2. **Controller dies mid-run**: start a long run, kill the Controller partway, wait 30s, restart. It catches up to the current step or to `completed`.
3. **Network to EC2 drops**: stop `tunnel.sh`. `ec2` turns `unreachable` with a retry countdown within
   ~15s; restart it and it turns healthy.
4. **Laptop sleep**: start a long fake run, close the lid for a minute, open it. A "wake detected,
   resyncing" event appears and runs catch up. The local runner sleeps too; testing that work
   continues while away needs a slow agent on EC2.

All four were run during the POC and passed (see SPEC.md 14a pass criteria).

## Done: one runner, many agents

Each machine runs one runner; each agent is a folder in `agents/` served at `/agents/<id>/`. The
Controller Model splits into `runners` (health, URL, token, location) and `agents` (key
`<runner>/<id>`, manifest info, schedule); tasks carry `runner` + `agent`. Reconnect logic is per
runner, unchanged. The Controller's Msg log from before this change was set aside as
`~/.agent-fleet/controller.db.v1-runner-per-agent` (old Msgs don't replay into the new Model).
