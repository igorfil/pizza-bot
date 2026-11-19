import { followModel, sendIntent } from "./api.ts";
import { runnersOf, selectedRunner, tasksOf, TERMINAL_STATES, type UiModel } from "./model.ts";
import { view } from "./view.ts";

const ESC = "\x1b[";
const FLASH_MS = 4_000;

let ui: UiModel = {
  connected: false,
  app: null,
  selected: 0,
  mode: { kind: "browse" },
  flash: null,
  width: process.stdout.columns ?? 100,
  height: process.stdout.rows ?? 30,
};

const render = () =>
  process.stdout.write(view(ui).map((line, i) => `${ESC}${i + 1};1H${line}${ESC}K`).join("") + `${ESC}J`);

const set = (patch: Partial<UiModel>) => {
  ui = { ...ui, ...patch };
  const count = ui.app ? runnersOf(ui.app).length : 0;
  ui = { ...ui, selected: Math.min(ui.selected, Math.max(count - 1, 0)) };
  render();
};

let flashTimer: Timer | undefined;
const flash = (level: "info" | "error", text: string) => {
  clearTimeout(flashTimer);
  set({ flash: { level, text } });
  flashTimer = setTimeout(() => set({ flash: null }), FLASH_MS);
};

const send = async (type: string, payload: Record<string, string>, success: string) => {
  const r = await sendIntent(type, payload);
  r.ok ? flash("info", success) : flash("error", `Couldn't send ${type}: ${r.error}`);
};

const defaultPrompt = (runner: string): string => {
  const app = ui.app;
  if (!app) return "";
  return tasksOf(app, runner)[0]?.prompt ?? app.runners[runner]?.agent?.examples[0] ?? "";
};

const quit = () => {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  process.exit(0);
};

const isPrintable = (key: string) => !key.startsWith("\x1b") && [...key].every((c) => c >= " " && c !== "\u007f");

const editInput = (input: string, key: string): string | null => {
  if (key === "\u007f") return input.slice(0, -1);
  if (key === "\u0015") return "";
  return isPrintable(key) ? input + key : null;
};

const onBrowseKey = (key: string) => {
  const runner = selectedRunner(ui);
  const count = ui.app ? runnersOf(ui.app).length : 0;
  switch (key) {
    case "q":
      return quit();
    case `${ESC}A`:
    case "k":
      return set({ selected: Math.max(0, ui.selected - 1) });
    case `${ESC}B`:
    case "j":
      return set({ selected: Math.min(count - 1, ui.selected + 1) });
    case "r":
    case "\r":
      if (!runner) return flash("error", "Add an agent first (press a).");
      return set({ mode: { kind: "run", runner: runner.name, input: defaultPrompt(runner.name) } });
    case "c": {
      const active = runner && ui.app ? tasksOf(ui.app, runner.name).find((t) => !TERMINAL_STATES.has(t.state)) : undefined;
      if (!active) return flash("info", "Nothing running on this agent.");
      return set({ mode: { kind: "confirmCancel", taskId: active.id } });
    }
    case "a":
      return set({ mode: { kind: "add", input: "" } });
  }
};

const onRunKey = (key: string, runner: string, input: string) => {
  if (key === "\x1b") return set({ mode: { kind: "browse" } });
  if (key === "\r") {
    set({ mode: { kind: "browse" } });
    return send("CreateTask", { runner, prompt: input.trim() }, `Started run on ${runner}.`);
  }
  const next = editInput(input, key);
  if (next !== null) set({ mode: { kind: "run", runner, input: next } });
};

const onAddKey = (key: string, input: string) => {
  if (key === "\x1b") return set({ mode: { kind: "browse" } });
  if (key === "\r") {
    const [name, url, token] = input.trim().split(/\s+/);
    if (!name || !url || !token) return flash("error", "Enter all three: <name> <url> <token>");
    set({ mode: { kind: "browse" } });
    return send("AddRunner", { name, url, token }, `Added agent ${name}.`);
  }
  const next = editInput(input, key);
  if (next !== null) set({ mode: { kind: "add", input: next } });
};

const onConfirmKey = (key: string, taskId: string) => {
  set({ mode: { kind: "browse" } });
  if (key === "y") send("CancelTask", { taskId }, "Cancel requested.");
};

const onKey = (key: string) => {
  if (key === "\u0003") return quit();
  const mode = ui.mode;
  switch (mode.kind) {
    case "browse":
      return onBrowseKey(key);
    case "run":
      return onRunKey(key, mode.runner, mode.input);
    case "add":
      return onAddKey(key, mode.input);
    case "confirmCancel":
      return onConfirmKey(key, mode.taskId);
  }
};

process.stdout.write(`${ESC}?1049h${ESC}?25l`);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => onKey(d));
process.stdout.on("resize", () => set({ width: process.stdout.columns, height: process.stdout.rows }));
process.on("SIGTERM", quit);
render();
followModel(
  (app) => set({ app }),
  (connected) => set({ connected }),
);
