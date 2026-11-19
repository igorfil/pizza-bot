export type AgentInfo = { description: string; examples: string[]; input: { label: string; hint: string } | null };

export type Runner = {
  name: string;
  url: string;
  status: "unknown" | "healthy" | "unreachable";
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  agent: AgentInfo | null;
};

export type Task = {
  id: string;
  runner: string;
  prompt: string;
  state: string;
  statusText: string | null;
  artifacts: { id: string; name: string; text: string }[];
  createdAt: number;
  updatedAt: number;
};

export type Notification = { at: number; level: "info" | "error"; text: string };

export type AppModel = {
  now: number;
  runners: Record<string, Runner>;
  tasks: Record<string, Task>;
  notifications: Notification[];
};

export type Mode =
  | { kind: "browse" }
  | { kind: "run"; runner: string; input: string }
  | { kind: "add"; input: string }
  | { kind: "confirmCancel"; taskId: string };

export type UiModel = {
  connected: boolean;
  app: AppModel | null;
  selected: number;
  mode: Mode;
  flash: { level: "info" | "error"; text: string } | null;
  width: number;
  height: number;
};

export const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected", "lost"]);

export const runnersOf = (app: AppModel): Runner[] =>
  Object.values(app.runners).sort((a, b) => a.name.localeCompare(b.name));

export const tasksOf = (app: AppModel, runner: string): Task[] =>
  Object.values(app.tasks)
    .filter((t) => t.runner === runner)
    .sort((a, b) => b.createdAt - a.createdAt);

export const selectedRunner = (ui: UiModel): Runner | undefined =>
  ui.app ? runnersOf(ui.app)[ui.selected] : undefined;
