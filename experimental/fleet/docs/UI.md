# The Fleet page

The Fleet backend's UI: a page in pizza-bot's web app, `apps/web/src/components/fleet/` (the
Electron shell loads the same app). It is a view of the Controller: it renders the Controller's
Model and sends it intents; nothing else.

Run it with `npm run dev` (Electron) or `npm run dev:both` (browser) from the repo root and open
**Fleet** in the left rail. It connects
with no setup: it defaults to `http://127.0.0.1:7700` with token `fleet-dev-token` (written by
`dev:both` and `dev.sh`), and the Controller allows the origins `http://localhost:5173` (Vite) and
`http://localhost:5273` (the Electron dev app from `npm run dev`).

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

Plus `scripts/fleet-dev.mjs`, which `npm run dev` and `npm run dev:both` (`scripts/dev-both.mjs`)
use to start the fleet next to pizza-bot.

Changed:

| File | Change |
|---|---|
| `admin-visibility.ts` | `"fleet"` added to `AppView` |
| `lexicon.ts` | `fleetSection: "Fleet"` |
| `components/AppNavigation.tsx` | `fleetDestination` (lucide `Network` icon) after MCP / Memories / Automations on desktop; under "More" on mobile |
| `App.tsx` | `view === "fleet"` branch rendering `<FleetScreen />` in a `module-hub` |
| `styles.css` | `fleet-*` classes (~150 lines) before the mobile breakpoint block; reuses `.dot-*`, `.field*`, `.btn-*`, `.module-tabs` |

## pizza-bot conventions followed
- No router: screens are an `AppView` union + rail entries + a ternary branch in `App.tsx`.
- `apps/web` must not import a runtime or model binding; the fleet code only uses `fetch`.
- Strings go in `lexicon.ts`; icons from `lucide-react`; toasts via `useAppToast`.
- Tests: Vitest, `renderToStaticMarkup`, no testing-library/jsdom.
- Don't add files under pizza-bot's `docs/`; fleet docs live in `experimental/fleet/`.
- `apps/web` never imports `experimental/` (ESLint `no-restricted-imports`).
- No CSP in the web app or Electron, so fetches to `127.0.0.1:7700` aren't blocked; CORS is the only
  gate, handled by the Controller's origin allowlist.

## Verified
- Repo-wide `npm run build && npm run typecheck && npm run lint && npm test` with the fleet in the
  workspace; `apps/web` 386 tests (54 fleet).
- Playwright against `npm run dev:both` (zero console errors): Fleet → Agents shows both runners
  healthy with their agents and the 07:30 schedule → Dad jokes "monorepos" → Inbox card with the
  jokes → follow-up in chat answered with the run as context → Ok, got it clears the card.
