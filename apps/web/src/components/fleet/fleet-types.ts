// Mirrors the agent-fleet Controller's public Model (GET /model). Runner tokens never reach the UI.
export type FleetRunnerStatus = "unknown" | "healthy" | "unreachable";

/** Which guide made a runner, and what removing it can also undo. */
export interface FleetRunnerOrigin {
  guide: string;
  summary: string;
  teardown: { label: string } | null;
}

export type FleetLink = { state: "up"; url: string } | { state: "down"; error: string | null };

/** A host process (one per machine). Health is per runner; it hosts many agents. */
export interface FleetRunner {
  name: string;
  transport: "direct" | "aws_ssm" | "ssh";
  /** The EC2 instance an aws_ssm runner lives on. */
  instanceId?: string | null;
  /** The runner is on this machine (a direct link to loopback); it can't be removed from the page. */
  local?: boolean;
  origin: FleetRunnerOrigin | null;
  link: FleetLink;
  status: FleetRunnerStatus;
  failures: number;
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  location: string | null;
  /** Agents the runner could serve but doesn't; null when it can't change its agents. */
  available?: FleetAgentInfo[] | null;
  /** The runner can create prompt agents (CreateAgent). */
  canCreateAgents?: boolean;
  agentsChange?: FleetAgentsChange | null;
}

export interface FleetAgentInfo {
  id: string;
  name: string;
  description: string;
}

/** In flight while `error` is null. */
export type FleetAgentsChange = { action: "add" | "remove"; agents: string[]; error: string | null };

/** What users run, schedule and see. Key: `<runner>/<id>`. */
export interface FleetAgent {
  key: string;
  runner: string;
  id: string;
  name: string;
  description: string;
  input: { label: string; hint: string; example: string } | null;
  schedule: { at: string; prompt: string } | null;
  /** Made with Create new; deleting it deletes it, while a shipped agent is only turned off. */
  created?: boolean;
}

export type FleetTaskState =
  | "queued"
  | "dispatching"
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "lost";

export interface FleetArtifact {
  id: string;
  name: string;
  text: string;
}

export interface FleetTask {
  id: string;
  runner: string;
  agent: string;
  prompt: string;
  state: FleetTaskState;
  statusText: string | null;
  artifacts: FleetArtifact[];
  createdAt: number;
  updatedAt: number;
  trigger?: "manual" | "schedule";
  ackedAt?: number | null;
}

export interface FleetNotification {
  at: number;
  level: "info" | "error";
  text: string;
}

export interface FleetChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface FleetChat {
  id: string;
  title: string;
  context: { taskId: string; text: string } | null;
  messages: FleetChatMessage[];
  pending: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FleetStepField {
  id: string;
  label: string;
  hint?: string;
  kind: "text" | "secret" | "choice";
  value?: string;
  options?: { value: string; label: string; detail?: string; disabled?: boolean }[];
}

/** One screen of a runner guide, drawn generically: the guide logic lives in the Controller. */
export interface FleetStepView {
  title: string;
  body?: string;
  progress?: string;
  fields: FleetStepField[];
  submit?: string;
  steps?: { labels: string[]; current: number };
  checklist?: FleetChecklistItem[];
}

export interface FleetChecklistItem {
  label: string;
  state: "done" | "current" | "pending" | "skipped" | "failed";
  detail?: string;
}

export interface FleetGuideSession {
  id: string;
  guide: string;
  status: "ask" | "working" | "failed";
  view: FleetStepView;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FleetGuideInfo {
  id: string;
  title: string;
  description: string;
  /** Listed in Add runner but not startable yet. */
  comingSoon?: boolean;
}

export interface FleetModel {
  now: number;
  runners: Record<string, FleetRunner>;
  agents: Record<string, FleetAgent>;
  tasks: Record<string, FleetTask>;
  chats?: Record<string, FleetChat>;
  guideSessions?: Record<string, FleetGuideSession>;
  guideCatalog?: FleetGuideInfo[];
  /** Models CreateAgent accepts. */
  agentModels?: { id: string; label: string }[];
  notifications: FleetNotification[];
}
