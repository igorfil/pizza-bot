// Mirrors the agent-fleet Controller's public Model (GET /model). Runner tokens never reach the UI.
export type FleetRunnerStatus = "unknown" | "healthy" | "unreachable";

/** A host process (one per machine). Health is per runner; it hosts many agents. */
export interface FleetRunner {
  name: string;
  url: string;
  status: FleetRunnerStatus;
  failures: number;
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  location: string | null;
}

/** What users run, schedule and see. Key: `<runner>/<id>`. */
export interface FleetAgent {
  key: string;
  runner: string;
  id: string;
  name: string;
  description: string;
  input: { label: string; hint: string; example: string } | null;
  schedule: { at: string; prompt: string } | null;
}

export type FleetTaskState =
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

export interface FleetModel {
  now: number;
  runners: Record<string, FleetRunner>;
  agents: Record<string, FleetAgent>;
  tasks: Record<string, FleetTask>;
  chats?: Record<string, FleetChat>;
  notifications: FleetNotification[];
}
