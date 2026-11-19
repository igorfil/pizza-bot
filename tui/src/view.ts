import {
  runnersOf,
  selectedRunner,
  tasksOf,
  TERMINAL_STATES,
  type AppModel,
  type Mode,
  type Runner,
  type Task,
  type UiModel,
} from "./model.ts";

type Seg = { text: string; style?: string };
type Line = Seg[];

const s = (text: string, style?: string): Seg => ({ text, style });

const BOLD = "1";
const DIM = "2";
const INVERSE = "7";
const RED = "31";
const GREEN = "32";
const YELLOW = "33";
const CYAN = "36";
const GRAY = "90";

const paint = (seg: Seg): string => (seg.style ? `\x1b[${seg.style}m${seg.text}\x1b[0m` : seg.text);

/** Truncates to `width` visible chars (with …) and pads, so borders line up. */
const fit = (line: Line, width: number): string => {
  const total = line.reduce((n, seg) => n + seg.text.length, 0);
  if (total <= width) return line.map(paint).join("") + " ".repeat(width - total);
  const { out } = line.reduce(
    (acc, seg) => {
      if (acc.left <= 0) return acc;
      const text = seg.text.length > acc.left ? seg.text.slice(0, Math.max(acc.left - 1, 0)) + "…" : seg.text;
      return { out: [...acc.out, { ...seg, text }], left: acc.left - text.length };
    },
    { out: [] as Seg[], left: width },
  );
  return out.map(paint).join("");
};

const wrap = (text: string, width: number): string[] =>
  text.split("\n").flatMap((para) =>
    para.split(/\s+/).reduce<string[]>((lines, word) => {
      const last = lines.at(-1);
      if (last === undefined) return [word];
      return (last + " " + word).length <= width ? [...lines.slice(0, -1), last + " " + word] : [...lines, word];
    }, []),
  );

const ago = (now: number, t: number): string => {
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
};

const duration = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
};

const STATE_STYLE: Record<string, { icon: string; style: string }> = {
  completed: { icon: "✓", style: GREEN },
  working: { icon: "◐", style: CYAN },
  submitted: { icon: "◐", style: CYAN },
  dispatching: { icon: "◐", style: CYAN },
  "input-required": { icon: "?", style: YELLOW },
  failed: { icon: "✗", style: RED },
  rejected: { icon: "✗", style: RED },
  lost: { icon: "✗", style: RED },
  canceled: { icon: "–", style: GRAY },
};

const stateStyle = (state: string) => STATE_STYLE[state] ?? { icon: "·", style: GRAY };

const RUNNER_STYLE: Record<Runner["status"], { dot: string; style: string }> = {
  healthy: { dot: "●", style: GREEN },
  unknown: { dot: "●", style: YELLOW },
  unreachable: { dot: "●", style: RED },
};

const box = (title: string, content: Line[], width: number, height: number): string[] => {
  const inner = width - 4;
  const name = title.slice(0, width - 6);
  const top = paint(s("┌ ", GRAY)) + paint(s(name, BOLD)) + paint(s(` ${"─".repeat(width - name.length - 4)}┐`, GRAY));
  const rows = Array.from({ length: height - 2 }, (_, i) => paint(s("│ ", GRAY)) + fit(content[i] ?? [], inner) + paint(s(" │", GRAY)));
  return [top, ...rows, paint(s(`└${"─".repeat(width - 2)}┘`, GRAY))];
};

const agentRows = (app: AppModel, runner: Runner, selected: boolean): Line[] => {
  const latest = tasksOf(app, runner.name)[0];
  const rs = RUNNER_STYLE[runner.status];
  const name: Line = [
    s(selected ? "▸ " : "  ", CYAN),
    s(rs.dot + " ", rs.style),
    s(runner.name, selected ? `${BOLD};${INVERSE}` : BOLD),
  ];
  const sub: Line = latest
    ? [s("    "), s(`${stateStyle(latest.state).icon} ${latest.state}`, stateStyle(latest.state).style), s(` · ${ago(app.now, latest.updatedAt)}`, GRAY)]
    : [s("    no runs yet", GRAY)];
  return [name, sub, []];
};

const runnerLine = (app: AppModel, r: Runner): Line => {
  const rs = RUNNER_STYLE[r.status];
  const health =
    r.status === "unreachable"
      ? `retry in ${Math.max(0, Math.round((r.nextCheckAt - app.now) / 1000))}s`
      : r.lastSeenAt !== null
        ? `seen ${ago(app.now, r.lastSeenAt)}`
        : "checking…";
  return [s(r.status, rs.style), s(`  ${r.url}  ·  ${health}`, GRAY)];
};

const cleanText = (text: string): string => text.replace(/\*\*/g, "");

const artifactLines = (t: Task, width: number, budget: number): Line[] => {
  const label = (k: string) => s(k.slice(0, 9).padEnd(10), GRAY);
  const finished = TERMINAL_STATES.has(t.state);
  if (t.artifacts.length === 0) return [[label("result"), s(finished ? "(no output)" : "(not ready yet)", GRAY)]];
  const newestFirst = [...t.artifacts].reverse();
  return newestFirst.reduce<Line[]>((lines, a, i) => {
    const left = budget - lines.length;
    if (left <= 0) return lines;
    const style = i === 0 ? undefined : GRAY;
    const wrapped = wrap(cleanText(a.text), width - 10);
    const shown = wrapped.length > left ? [...wrapped.slice(0, left - 1), `… ${wrapped.length - left + 1} more lines`] : wrapped;
    return [...lines, ...shown.map((l, j): Line => [j === 0 ? label(a.name || a.id) : s(" ".repeat(10)), s(l, style)])];
  }, []);
};

const latestRunLines = (app: AppModel, t: Task, width: number, budget: number): Line[] => {
  const st = stateStyle(t.state);
  const finished = TERMINAL_STATES.has(t.state);
  const timing = finished
    ? `finished ${ago(app.now, t.updatedAt)} · took ${duration(t.updatedAt - t.createdAt)}`
    : `started ${ago(app.now, t.createdAt)} · running ${duration(app.now - t.createdAt)}`;
  const label = (k: string) => s(k.padEnd(10), GRAY);
  const head: Line[] = [
    [s("LATEST RUN  ", BOLD), s(`${st.icon} ${t.state}`, st.style), s(`  ${timing}`, GRAY)],
    [label("input"), t.prompt ? s(t.prompt) : s("(none)", GRAY)],
    [label("status"), s(t.statusText ?? "—", finished ? undefined : CYAN)],
  ];
  return [...head, ...artifactLines(t, width, Math.max(budget - head.length, 1))];
};

const recentRunLines = (app: AppModel, tasks: Task[]): Line[] =>
  tasks.length === 0
    ? []
    : [
        [s("RECENT RUNS", BOLD)],
        ...tasks.map((t): Line => {
          const st = stateStyle(t.state);
          return [s(`${st.icon} `, st.style), s(t.state.padEnd(15), st.style), s(ago(app.now, t.createdAt).padEnd(10), GRAY), t.prompt ? s(t.prompt) : s("(no input)", GRAY)];
        }),
      ];

const RECENT_RUNS = 4;

const detailLines = (app: AppModel, r: Runner, width: number, height: number): Line[] => {
  const tasks = tasksOf(app, r.name);
  const latest = tasks[0];
  const header: Line[] = [
    runnerLine(app, r),
    ...(r.lastError && r.status !== "healthy" ? [[s(r.lastError, RED)] as Line] : []),
    ...(r.agent?.description ? wrap(r.agent.description, width).map((l): Line => [s(l, DIM)]) : []),
    [],
  ];
  if (!latest) return [...header, [s("No runs yet. Press "), s("r", BOLD), s(" to run this agent.")]];
  const older = tasks.slice(1, 1 + RECENT_RUNS);
  const recent = recentRunLines(app, older);
  const budget = height - header.length - (recent.length ? recent.length + 1 : 0);
  return [...header, ...latestRunLines(app, latest, width, budget), ...(recent.length ? [[] as Line, ...recent] : [])];
};

const header = (ui: UiModel, width: number): string => {
  const app = ui.app;
  const running = app ? Object.values(app.tasks).filter((t) => !TERMINAL_STATES.has(t.state)).length : 0;
  const agents = app ? Object.keys(app.runners).length : 0;
  const left: Line = [s(" agent-fleet", BOLD), s(`   ${agents} agents · ${running} running`, GRAY)];
  const right: Line = ui.connected ? [s("● ", GREEN), s("controller connected ")] : [s("● ", RED), s("controller disconnected, retrying… ", RED)];
  const rightLen = right.reduce((n, seg) => n + seg.text.length, 0);
  return fit(left, width - rightLen) + fit(right, rightLen);
};

const statusLine = (ui: UiModel, width: number): string => {
  if (ui.flash) return fit([s(" "), s(ui.flash.text, ui.flash.level === "error" ? RED : YELLOW)], width);
  const last = ui.app?.notifications.at(-1);
  if (!last || !ui.app) return " ".repeat(width);
  return fit([s(" "), s(last.level === "error" ? "! " : "· ", last.level === "error" ? RED : GRAY), s(last.text, GRAY), s(`  ${ago(ui.app.now, last.at)}`, GRAY)], width);
};

const keyHint = (key: string, label: string): Seg[] => [s(` ${key} `, INVERSE), s(` ${label}   `)];

const footer = (mode: Mode, runner: Runner | undefined, width: number): string => {
  switch (mode.kind) {
    case "browse":
      return fit(
        [
          s(" "),
          ...keyHint("↑↓", "select"),
          ...(runner ? [...keyHint("r", `run ${runner.name}`), ...keyHint("c", "cancel")] : []),
          ...keyHint("a", "add agent"),
          ...keyHint("q", "quit"),
        ],
        width,
      );
    case "run": {
      const input = runner?.agent?.input;
      return fit(
        [
          s(` Run ${mode.runner}`, `${BOLD};${CYAN}`),
          ...(input?.label ? [s(` · ${input.label}`, CYAN)] : []),
          s(" › ", `${BOLD};${CYAN}`),
          s(mode.input),
          s(" ", INVERSE),
          s(`   ${input?.hint ? input.hint + " · " : ""}Enter start · Esc back`, GRAY),
        ],
        width,
      );
    }
    case "add":
      return fit([s(" Add agent › ", `${BOLD};${CYAN}`), s(mode.input), s(" ", INVERSE), s("   <name> <url> <token> · Enter add · Esc back", GRAY)], width);
    case "confirmCancel":
      return fit([s(` Cancel run ${mode.taskId.slice(0, 8)} on ${runner?.name ?? "?"}? `, `${BOLD};${YELLOW}`), ...keyHint("y", "yes"), ...keyHint("n", "no")], width);
  }
};

/** Returns one string per terminal row. */
export const view = (ui: UiModel): string[] => {
  const width = Math.max(ui.width, 60);
  const bodyHeight = Math.max(ui.height - 3, 8);
  const leftWidth = Math.min(Math.max(Math.floor(width * 0.3), 26), 40);
  const rightWidth = width - leftWidth;
  const app = ui.app;
  const runner = selectedRunner(ui);

  const leftContent: Line[] = !app
    ? [[s("connecting…", GRAY)]]
    : runnersOf(app).length === 0
      ? [[s("No agents yet.", GRAY)], [s("Press "), s("a", BOLD), s(" to add one.")]]
      : runnersOf(app).flatMap((r, i) => agentRows(app, r, i === ui.selected));
  const rightContent: Line[] =
    app && runner ? detailLines(app, runner, rightWidth - 4, bodyHeight - 2) : [[s("Select an agent to see its runs.", GRAY)]];

  const left = box("Agents", leftContent, leftWidth, bodyHeight);
  const right = box(runner?.name ?? "Details", rightContent, rightWidth, bodyHeight);
  return [header(ui, width), ...left.map((l, i) => l + right[i]), statusLine(ui, width), footer(ui.mode, runner, width)];
};
