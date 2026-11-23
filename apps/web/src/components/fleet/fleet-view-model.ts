import type { FleetAgent, FleetChat, FleetGuideSession, FleetModel, FleetRunner, FleetStepView, FleetTask, FleetTaskState } from "./fleet-types.js";

const TERMINAL: ReadonlySet<FleetTaskState> = new Set(["completed", "failed", "canceled", "rejected", "lost"]);

export const isFinished = (task: FleetTask): boolean => TERMINAL.has(task.state);

export const taskAgentKey = (task: FleetTask): string => `${task.runner}/${task.agent}`;

export const agentsOf = (model: FleetModel): FleetAgent[] =>
  Object.values(model.agents ?? {}).sort((a, b) => a.runner.localeCompare(b.runner) || a.name.localeCompare(b.name));

export const agentOfTask = (model: FleetModel, task: FleetTask): FleetAgent | undefined => model.agents?.[taskAgentKey(task)];

export const agentName = (model: FleetModel, task: FleetTask): string => agentOfTask(model, task)?.name ?? task.agent;

export const runsOf = (model: FleetModel, agentKey: string): FleetTask[] =>
  Object.values(model.tasks)
    .filter((t) => taskAgentKey(t) === agentKey)
    .sort((a, b) => b.createdAt - a.createdAt);

export const activeRun = (model: FleetModel, agentKey: string): FleetTask | undefined =>
  runsOf(model, agentKey).find((t) => !isFinished(t));

export const runningCount = (model: FleetModel): number =>
  Object.values(model.tasks).filter((t) => !isFinished(t)).length;

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export const runnerTone = (status: FleetRunner["status"]): Tone =>
  status === "healthy" ? "ok" : status === "unreachable" ? "bad" : "warn";

export const taskTone = (state: FleetTaskState): Tone => {
  switch (state) {
    case "completed":
      return "ok";
    case "failed":
    case "rejected":
    case "lost":
      return "bad";
    case "input-required":
      return "warn";
    case "canceled":
      return "muted";
    default:
      return "info";
  }
};

/** Last prompt wins over the manifest example: re-running with tweaks is the common case. */
export const defaultInput = (model: FleetModel, agentKey: string): string =>
  runsOf(model, agentKey)[0]?.prompt ?? model.agents?.[agentKey]?.input?.example ?? "";

/** Newest artifact first, so a final summary shows above the raw data it was built from. */
export const artifactsNewestFirst = (task: FleetTask) => [...task.artifacts].reverse();

export const ago = (now: number, at: number): string => {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
};

export const duration = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
};

export const runnerHealth = (model: FleetModel, r: FleetRunner): string => {
  if (r.status === "unreachable") return `retry in ${Math.max(0, Math.round((r.nextCheckAt - model.now) / 1000))}s`;
  if (r.lastSeenAt === null) return "checking…";
  return `seen ${ago(model.now, r.lastSeenAt)}`;
};

/** The runner's state in words, so the status dot never carries meaning alone. */
export const runnerStatusText = (model: FleetModel, r: FleetRunner): string => {
  if (r.status === "unreachable") return `unreachable · ${runnerHealth(model, r)}`;
  if (r.status === "unknown" || r.lastSeenAt === null) return "checking…";
  return `online · ${runnerHealth(model, r)}`;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const agentsSummary = (model: FleetModel): string =>
  `${plural(Object.keys(model.agents).length, "agent", "agents")} on ${plural(Object.keys(model.runners).length, "runner", "runners")}`;

/** Names for agent ids a runner offers or serves, falling back to the id. */
export const agentNames = (model: FleetModel, r: FleetRunner, ids: string[]): string =>
  ids.map((id) => model.agents[`${r.name}/${id}`]?.name ?? r.available?.find((a) => a.id === id)?.name ?? id).join(", ");

/** Long enough that every set-up step normally reports progress first: polls do every 5s, the tunnel check gives up at 45s. */
export const STUCK_MS = 60_000;

/** How long a running guide step has gone without progress, once that looks stuck; else null. */
export const stuckFor = (now: number, s: FleetGuideSession): number | null =>
  s.status === "working" && now - s.updatedAt >= STUCK_MS ? now - s.updatedAt : null;

/** One line for a guide that is still open, shown on the page while its dialog is closed. */
export const guideStatusText = (s: FleetGuideSession): string =>
  s.status === "working" ? (s.view.progress ?? s.view.title) : s.status === "failed" ? `Stopped: ${s.error ?? s.view.title}` : `Waiting for you: ${s.view.title}`;

/** The history strip in words, for screen readers. */
export const stripSummary = (tasks: FleetTask[]): string => {
  if (tasks.length === 0) return "No runs yet";
  const counts = tasks.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.state]: (acc[t.state] ?? 0) + 1 }), {});
  return `Last ${plural(tasks.length, "run", "runs")}: ${Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([state, n]) => `${n} ${state}`).join(", ")}`;
};

/** Finished runs nobody has dealt with yet, newest first (same rule as the Controller). */
export const inboxOf = (model: FleetModel): FleetTask[] =>
  Object.values(model.tasks)
    .filter((t) => isFinished(t) && !t.ackedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);

export const chatsOf = (model: FleetModel): FleetChat[] =>
  Object.values(model.chats ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);

export const inputLabel = (agent: FleetAgent | undefined): string => agent?.input?.label || "Input";

/** Card heading for an inbox item: what was asked, in the agent's own words. */
export const runTitle = (model: FleetModel, task: FleetTask): string => {
  const agent = agentOfTask(model, task);
  if (!task.prompt) return `Your ${(agent?.name ?? task.agent).toLowerCase()}`;
  return `${inputLabel(agent)}: ${task.prompt}`;
};

/** Where a runner is: what it says, else how it was set up, else the host it's reached at. */
export const runnerLocation = (r: FleetRunner): string => {
  if (r.location) return r.location;
  if (r.origin?.summary) return r.origin.summary;
  if (r.link.state !== "up") return r.transport === "aws_ssm" ? "AWS (tunnel)" : r.transport === "ssh" ? "SSH (tunnel)" : "not connected";
  try {
    return new URL(r.link.url).host;
  } catch {
    return r.link.url;
  }
};

export const RUN_STRIP_LENGTH = 10;

/** Oldest-to-newest outcomes of the last runs, for the agent card's history strip. */
export const runStrip = (model: FleetModel, agentKey: string): FleetTask[] =>
  runsOf(model, agentKey).slice(0, RUN_STRIP_LENGTH).reverse();

/** Guides in progress, oldest first; they stay on screen across reloads until done or canceled. */
export const guideSessionsOf = (model: FleetModel): FleetGuideSession[] =>
  Object.values(model.guideSessions ?? {}).sort((a, b) => a.createdAt - b.createdAt);

/** Starting values for a step's form: what the guide suggests, else the first selectable choice. */
export const initialDraft = (view: FleetStepView): Record<string, string> =>
  Object.fromEntries(
    view.fields.map((f) => [f.id, f.value ?? (f.kind === "choice" ? (f.options?.find((o) => !o.disabled)?.value ?? "") : "")]),
  );
