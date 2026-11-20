export type AgentInfo = { description: string; examples: string[]; input: { label: string; hint: string } | null };

/** One selectable row: an agent (`name` is its `<runner>/<id>` key) with its runner's health. */
export type Runner = {
  name: string;
  url: string;
  status: "unknown" | "healthy" | "unreachable";
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  agent: AgentInfo | null;
};

type HostRunner = Omit<Runner, "agent">;

type Agent = {
  key: string;
  runner: string;
  name: string;
  description: string;
  input: { label: string; hint: string; example: string } | null;
};

export type Task = {
  id: string;
  runner: string;
  agent: string;
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
  runners: Record<string, HostRunner>;
  agents: Record<string, Agent>;
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

const toRow = (app: AppModel, a: Agent): Runner | null => {
  const host = app.runners[a.runner];
  if (!host) return null;
  return {
    ...host,
    name: a.key,
    agent: {
      description: `${a.name}: ${a.description}`,
      examples: a.input?.example ? [a.input.example] : [],
      input: a.input ? { label: a.input.label, hint: a.input.hint } : null,
    },
  };
};

export const runnersOf = (app: AppModel): Runner[] =>
  Object.values(app.agents ?? {})
    .map((a) => toRow(app, a))
    .filter((r): r is Runner => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

export const tasksOf = (app: AppModel, agentKey: string): Task[] =>
  Object.values(app.tasks)
    .filter((t) => `${t.runner}/${t.agent}` === agentKey)
    .sort((a, b) => b.createdAt - a.createdAt);

export const selectedRunner = (ui: UiModel): Runner | undefined =>
  ui.app ? runnersOf(ui.app)[ui.selected] : undefined;
