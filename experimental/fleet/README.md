# agent-fleet

A proof of concept for orchestrating, observing and controlling AI agents that run on other machines.
A headless **Controller** on the laptop talks to **Runners** over A2A. UIs (a TUI, and an *Agent Fleet*
screen in pizza-bot) are thin views of the Controller.

Agents keep working while the laptop sleeps or the Controller is down; the Controller catches up when
it comes back.

- Design and decisions: [SPEC.md](SPEC.md) (section 14a is the POC scope)
- What the POC skips: [POC-GAPS.md](POC-GAPS.md)
- EC2 and AWS details: [docs/DEPLOY.md](docs/DEPLOY.md)
- Verified facts and gotchas: [docs/LEARNINGS.md](docs/LEARNINGS.md)
- The pizza-bot UI client: [docs/PIZZA-BOT.md](docs/PIZZA-BOT.md)

## Quick start

```bash
./dev.sh                       # Controller :7700, laptop runner :9301 (agents/), tunnel to EC2 :9471
cd tui && bun src/main.ts      # terminal UI
```

`dev.sh` writes the fixed dev token `fleet-dev-token` to `~/.agent-fleet/token`, so every UI connects
with no setup. Ctrl-C stops everything it started. The pizza-bot screen is covered in
[docs/PIZZA-BOT.md](docs/PIZZA-BOT.md).

First run only: register the runners (the Controller remembers them in its Msg log). In the TUI press
`a`, or:

```bash
H="authorization: Bearer fleet-dev-token"
curl -X POST localhost:7700/msg -H "$H" -d '{"msg_id":"r1","type":"AddRunner","payload":{"name":"laptop","url":"http://127.0.0.1:9301","token":"localtoken"}}'
curl -X POST localhost:7700/msg -H "$H" -d '{"msg_id":"r2","type":"AddRunner","payload":{"name":"ec2","url":"http://127.0.0.1:9471","token":"<EC2 runner token>"}}'
```

## The system

```
╔════════════════════════════════════ YOUR LAPTOP ════════════════════════════════════╗
║                                                                                     ║
║  ┌─ TUI / pizza-bot screen ───────┐          ┌─ CONTROLLER ── process (daemon) ───┐ ║
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
║  │  /agents/sysreport     agents/sysreport/agent.py        │   │ auto-reconnect  │  ║
║  │  /agents/morningbrief  agents/morningbrief/agent.py     │   └────────┬────────┘  ║
║  │  /agents/slow          agents/slow/agent.py             │            │           ║
║  └─────────────────────────────────────────────────────────┘            │           ║
╚═════════════════════════════════════════════════════════════════════════┼═══════════╝
                                                                          │ SSH over SSM
╔═════════════════════════════════════ AWS EC2 ════════════════════════════┼═══════════╗
║  ┌─ RUNNER "ec2" ── systemd service ──────────────────────────────────────▼────────┐ ║
║  │  127.0.0.1:9000 · auth · task store (SQLite) · GET /agents                       │ ║
║  │  /agents/dadjokes      /opt/fleet-agents/dadjokes/agent.py (uv)                 │ ║
║  └─────────────────────────────────────────────────────────────────────────────────┘ ║
║  security group: no inbound · IAM role: SSM, S3 read, invoke terra                   ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
```

The Controller always dials out. Runners never call the laptop, because the laptop is the side that
sleeps.

| Process | Holds | Can die without losing work? |
|---|---|---|
| UI (TUI, pizza-bot) | Screen state only | Yes. Reopen and it reloads the Model. |
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

## Repo layout

```
agent-fleet/
├── SPEC.md · POC-GAPS.md · README.md
├── dev.sh                 start Controller + laptop runner + tunnel with the dev token
├── agents/                one folder per agent: agent.toml + code (README.md = the contract)
├── docs/                  DEPLOY.md · LEARNINGS.md · PIZZA-BOT.md
├── controller/            Bun + TypeScript
│   ├── src/types.ts       Model, Msg (intent + world), Effect, Sub
│   ├── src/update.ts      pure update + subscriptions; all timing constants
│   ├── src/runtime.ts     single update loop, effect executor, stream reconciler
│   ├── src/a2a.ts         the only file that knows A2A (@a2a-js/sdk)
│   ├── src/chat.ts        pure chat transitions + system prompt
│   ├── src/llm.ts         Bedrock Converse for chat (@aws-sdk/client-bedrock-runtime)
│   ├── src/api.ts         HTTP + SSE API, auth, browser-origin allowlist
│   ├── src/log.ts         SQLite Msg log (bun:sqlite)
│   └── test/update.test.ts
├── tui/                   Bun + TypeScript, no dependencies
│   └── src/               model · view (pure) · api · main (keys)
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
| `GET /model/stream` | SSE. Each event is the full `{version, model}`; keepalive comment every 15s. |

Intents (only these are accepted over the API; world Msgs are rejected):

| type | payload |
|---|---|
| `AddRunner` | `name, url, token` |
| `RemoveRunner` | `name` |
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
- Every Msg is logged before `update` runs. On start the log is replayed with effects dropped, then
  `Booted` is dispatched.

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

A generic host: one process per machine, serving every agent folder in `RUNNER_AGENTS_DIR`. It knows
nothing about what agents do. Agents are separate programs (any language, or Docker); the contract
is in [agents/README.md](agents/README.md): JSON on stdin, JSON-line events on stdout, exit code.

| Env | Default | |
|---|---|---|
| `RUNNER_TOKEN` | required | bearer token the Controller must send |
| `RUNNER_AGENTS_DIR` | `agents` | folder of agent folders |
| `RUNNER_AGENTS` | all | comma list of agent ids to serve (an unknown id is a startup error) |
| `RUNNER_BIND` | `127.0.0.1:9000` | |
| `RUNNER_PUBLIC_URL` | `http://$RUNNER_BIND` | base URL agent cards advertise; must be the URL the Controller uses |
| `RUNNER_DB` | `runner.db` | SQLite task store, shared by all its agents |
| `RUNNER_NAME` | `runner` | runner name in `GET /agents` |
| `RUNNER_LOCATION` | none | where it runs ("this laptop", "EC2 us-west-2"); in `GET /agents` and card `provider.organization` |

Agents inherit the runner's environment (so `PATH`, AWS credentials), plus their manifest's `[env]`.

Endpoints:
- `GET /agents`: public; `{runner, location, agents: [{id, name, description, input, url}]}`. The
  Controller uses it for discovery and as the runner health check.
- `/agents/<id>/.well-known/agent-card.json`: public A2A agent card per agent. Its one skill carries
  the input label (`name`), hint (`description`) and default input (`examples[0]`).
- `/agents/<id>/jsonrpc`: A2A v1.0 JSON-RPC, bearer token required.

Agents in this repo (details in [agents/README.md](agents/README.md)):

| Agent | Where | Input | Does | Artifacts |
|---|---|---|---|---|
| `dadjokes` | EC2 | topic | Bedrock `gpt-6.1-terra` writes 5 dad jokes | `jokes` |
| `sysreport` | laptop | optional focus | `sysinfo.sh` → Bedrock Haiku summary, OK / WATCH / HOT | `metrics`, `summary` |
| `morningbrief` | laptop | optional focus | Outlook MCP (inbox 24h + today's calendar) → Bedrock Haiku brief | `brief` |
| `slow` | laptop | `steps=N every=S text` | N progress updates S seconds apart; no LLM | `result` |

`morningbrief` uses the Python MCP SDK to spawn `aws-outlook-mcp` (aim/toolbox, `~/.toolbox/bin`)
per run, read-only. Mail and calendar go to the model inside `<emails>` / `<calendar>` with an
instruction to treat them as untrusted data. It needs a fresh Midway session (`mwinit`).

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

`laptop/morningbrief` is scheduled for 07:30.

## TUI

`cd tui && bun src/main.ts`. Reads `~/.agent-fleet/token`; `FLEET_PORT` and `FLEET_HOME` override.

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | select agent |
| `r` or Enter | run the selected agent (rows are `<runner>/<id>`); prompt bar pre-filled with the last input or the manifest example |
| `c` | cancel the agent's active run (confirm with `y`) |
| `a` | add runner: `name url token` (its agents appear once it answers) |
| `q` / Ctrl-C | quit |

## Testing

```bash
cd controller && bun test && bunx tsc --noEmit -p .   # update() table tests + typecheck
cd tui && bunx tsc --noEmit -p .
cd runner && cargo test
cd agents/dadjokes && echo '{"input":"tacos"}' | uv run --quiet agent.py   # any agent, without a runner
```

`view.ts` in the TUI is pure, so a screen can be rendered from the live Model without a terminal.

### Reconnect scenarios

The real agents finish in seconds. For mid-run tests use `laptop/slow` (served by `dev.sh`), e.g.
input `steps=20 every=3 x`.

1. **Close the UI**: start a run, quit, reopen. The result is there.
2. **Controller dies mid-run**: run `steps=20 every=3 x` on `laptop/slow`, kill the Controller at step 3, wait
   30s, restart. It catches up to the current step or to `completed`.
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
