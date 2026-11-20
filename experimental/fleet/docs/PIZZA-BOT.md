# pizza-bot: Agent Fleet screen

A UI client for this fleet, added as a new screen in pizza-bot's web app (also loaded by its
Electron shell). It is a view of the Controller, like the TUI: same Model, same intents.

## Where it lives

| | |
|---|---|
| Repo | `~/dev/pizza-bot` |
| Branch | `feat/agent-fleet-screen`, from `main` at `bb9ce39` (local `main` was behind `origin/main`) |
| Worktree | `~/dev/pizza-bot/.worktrees/agent-fleet-screen` (the repo's rule: one worktree per branch) |
| Status | uncommitted, not pushed |
| Full change | [`integrations/pizza-bot/agent-fleet-screen.patch`](../integrations/pizza-bot/agent-fleet-screen.patch) (14 files; applies cleanly to `bb9ce39` with `git apply`) |

## How to run it

```bash
# terminal 1, this repo
./dev.sh

# terminal 2, the pizza-bot worktree
./scripts/dev-fleet.sh       # pizza-bot api-server :8080 + Vite :5173
```

Open http://localhost:5173 and click **Agent Fleet** in the left rail. It connects with no setup:
the screen defaults to `http://127.0.0.1:7700` with token `fleet-dev-token`, which `dev.sh` writes,
and `dev.sh` allows the origins `http://localhost:5173` and `http://localhost:5273` (the Electron dev
app from pizza-bot's `npm run dev`).

`dev-fleet.sh` runs pizza-bot's api-server too, because the rest of the app (settings, status,
threads) needs it; without it Vite logs `http proxy error … ECONNREFUSED` for `/settings`, `/status`
and others. Its data goes to `/tmp/pizza-bot-fleet-dev` (override with `PIZZA_DATA_ROOT`), so tests
don't touch real pizza-bot data.

## What the screen does

Three views inside the one screen, as tabs under the header (from the Inbox / Chats / Agents
mockups). The header has the link status (Live / Connecting… / Reconnecting… / Not connected) and a
Connection button.

### Inbox: a stack of results

```
 Inbox (15) · Chats · Agents
           15 results to review                          [Mark all read]
  ┌────────────────────────────────────────────────────────┐
  │ (ec2) completed · just now                             │
  │                   Topic: tacos                         │  ← skill label + input
  │ ┌────────────────────────────────────────────────────┐ │
  │ │ 1. … 5. …   (markdown, via pizza-bot Streamdown)   │ │  ← newest artifact
  │ └────────────────────────────────────────────────────┘ │
  │ ▸ metrics  (older artifacts collapsed)                 │
  │ [ Ask a follow-up about this result…           ] [➤]  │  → new chat seeded with the run
  │      [↻ Run again] [💬 Continue in chat] [✓ Ok, got it]│
  └────────────────────────────────────────────────────────┘┘┘  ← next items peek out behind
```

- Items = finished runs not yet acknowledged, newest first; the tab shows the count.
- Ok, got it → `AckInbox`; Mark all read → `AckAllInbox`; Run again → `CreateTask` with the same
  input; Continue in chat / follow-up → `CreateChat {fromTaskId, text}` and switches to Chats with
  that chat open.
- Failed runs show the reason in a red banner. Empty state: "All caught up".

### Chats: plain conversation with the Controller's LLM

- Chat list (newest first, "from run" badge, "replying…" while pending) + New chat.
- Conversation uses pizza-bot's own `Message` / `MessageContent` / `MessageResponse` (markdown) and
  `Conversation` (stick-to-bottom). User bubbles right, assistant bubbles left with a brand border.
- Chats started from a run show a collapsible "Started from an agent result" with the run text.
- Typing indicator while pending; failure shown inline; Enter sends, Shift+Enter new line. A new
  chat is created on the first message (`CreateChat {text}`), and the returned id is selected.

### Agents: monitor grid

- Grouped by runner: a header per runner (name, health dot, location with laptop/cloud icon, last
  seen or "unreachable · retry in Ns" with the error, remove-runner button), then its agent cards.
- One card per agent (`<runner>/<id>` shown on the card): name, health dot, "On <location>" (laptop or cloud icon), description from
  the agent card, health line or live status of the active run (with cancel), and a strip of the
  last 10 runs (green ok, red failed, grey canceled, pulsing blue running; tooltip has state, age,
  input).
- [runs] expands the card in place with the last 5 runs. [evals] is disabled ("coming soon").
- Schedule row: "Daily at 07:30 · change" or "Not scheduled · schedule"; inline time picker with
  Save / turn off / cancel (`SetSchedule`). Scheduled runs show a "scheduled" chip on their inbox
  card; runs without input are titled "Your <agent> report".
- Run opens an inline input on the card (labelled and hinted from the agent card, pre-filled with
  the last input); the result lands in the Inbox. Trash icon removes the agent after confirmation.
- Unreachable runners are greyed out with "UNREACHABLE · retry in Ns" and the error.
- A dashed "Add runner" card turns into the add form (name, runner URL as the Controller sees it,
  runner token); the runner's agents appear once it answers.

### Connection
- Connect form: shown when the user opens Connection, or when the Controller rejects the token (401)
  or the origin (403); it shows the exact fix (`cat ~/.agent-fleet/token`,
  `FLEET_ALLOWED_ORIGINS=<this origin>`). The choice is saved in `localStorage`
  (`pizza.fleet.connection`); otherwise the dev connection is used.
- Live updates over the Controller's SSE stream, read with `fetch` (EventSource can't send the
  Authorization header). Reconnects every 2s; stops on 401/403 because retrying won't fix those.
  The stream is open only while the screen is mounted.

## Files

New, all in `apps/web/src/components/fleet/`:

| File | Role |
|---|---|
| `fleet-types.ts` | mirror of the Controller's public Model (runners, tasks, chats) |
| `fleet-client.ts` | `sendFleetIntent` (POST /msg, returns the minted id), `streamFleetModel` (SSE via fetch + `eventsource-parser`), connection storage, dev default |
| `use-fleet.ts` | hook: connection, Model, link state, retry loop |
| `fleet-view-model.ts` | pure helpers: inbox, chats, runs per agent, run strip, titles, location, tones, time formats |
| `FleetModule.tsx` | hub: header, `ModuleTabs` (Inbox / Chats / Agents), `FleetLinkBadge`, `FleetConnectForm` |
| `InboxView.tsx` | stack + `InboxCard` |
| `ChatsView.tsx` | chat list + `ChatPane` |
| `AgentsView.tsx` | grid + `AgentCard`, inline runs, add-agent card |
| `FleetScreen.tsx` | container: hook + chooses connect form or hub |
| `fleet-view-model.test.ts`, `FleetModule.test.tsx` | 50 tests (`renderToStaticMarkup`, the repo's no-DOM pattern) |

Plus `scripts/dev-fleet.sh` (test launcher).

Changed:

| File | Change |
|---|---|
| `admin-visibility.ts` | `"fleet"` added to `AppView` |
| `lexicon.ts` | `fleetSection: "Agent Fleet"` |
| `components/AppNavigation.tsx` | `fleetDestination` (lucide `Network` icon) after MCP / Memories / Automations on desktop; under "More" on mobile |
| `App.tsx` | `view === "fleet"` branch rendering `<FleetScreen />` in a `module-hub` |
| `styles.css` | `fleet-*` classes (~150 lines) before the mobile breakpoint block; reuses `.dot-*`, `.field*`, `.btn-*`, `.module-tabs` |

## pizza-bot conventions followed
- No router: screens are an `AppView` union + rail entries + a ternary branch in `App.tsx`.
- `apps/web` must not import a runtime or model binding; the fleet code only uses `fetch`.
- Strings go in `lexicon.ts`; icons from `lucide-react`; toasts via `useAppToast`.
- Tests: Vitest, `renderToStaticMarkup`, no testing-library/jsdom.
- Branch `<type>/<kebab>` in `.worktrees/<kebab>`; `npm install` + `npm run build` in a new worktree
  (imports of `@pizza-bot/*` resolve to `dist/`). Don't push or merge unless asked.
- Don't add files under pizza-bot's `docs/`.
- No CSP in the web app or Electron, so fetches to `127.0.0.1:7700` aren't blocked; CORS is the only
  gate, handled by the Controller's origin allowlist.

## Verified
- `npx tsc --noEmit -p apps/web/tsconfig.json` clean; `npx eslint` clean on changed files.
- `npx vitest run --dir apps/web`: 379 tests pass (47 fleet).
- Playwright against the running stack (zero console errors):
  1. Agents → ec2 card shows "On EC2 us-west-2" → Run → topic "tacos".
  2. Inbox → card "Topic: tacos" on top with the 5 jokes.
  3. Follow-up "Which of these is the best one?" → switches to Chats → Haiku answers with the run as
     context.
  4. New chat → "Say hello in exactly five words." → "Hello there, how are you?".
  5. Inbox → Ok, got it → count 15 → 14, card gone.

## Re-applying elsewhere

```bash
cd ~/dev/pizza-bot
git worktree add .worktrees/agent-fleet-screen -b feat/agent-fleet-screen main
cd .worktrees/agent-fleet-screen
git apply ~/dev/tmp-projects/agent-fleet/integrations/pizza-bot/agent-fleet-screen.patch
npm install && npm run build
```

If `main` has moved, use `git apply -3` and resolve conflicts in `App.tsx` / `AppNavigation.tsx`.
