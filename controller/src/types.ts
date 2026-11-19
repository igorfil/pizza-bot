export type RunnerStatus = "unknown" | "healthy" | "unreachable";

export type AgentInfo = { description: string; examples: string[]; input: { label: string; hint: string } | null };

export type Runner = {
  name: string;
  url: string;
  token: string;
  status: RunnerStatus;
  failures: number;
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  agent: AgentInfo | null;
};

export type TaskState =
  | "dispatching"
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "lost";

export type Artifact = { id: string; name: string; text: string };

export type Task = {
  id: string;
  runner: string;
  prompt: string;
  remoteId: string | null;
  state: TaskState;
  statusText: string | null;
  artifacts: Artifact[];
  createdAt: number;
  updatedAt: number;
  lastSyncAt: number;
  streamEpoch: number;
  streamFailures: number;
  streamRetryAt: number;
};

export type Notification = { at: number; level: "info" | "error"; text: string };

export type Model = {
  now: number;
  runners: Record<string, Runner>;
  tasks: Record<string, Task>;
  notifications: Notification[];
};

/** Runtime-neutral view of a remote task. The A2A adapter maps into this. */
export type TaskSnapshot = {
  remoteId: string;
  state: Exclude<TaskState, "dispatching" | "lost">;
  statusText: string | null;
  artifacts: Artifact[];
};

export type TaskUpdate = {
  state?: TaskSnapshot["state"];
  statusText?: string | null;
  artifact?: Artifact;
};

export type IntentMsg =
  | { type: "AddRunner"; name: string; url: string; token: string }
  | { type: "RemoveRunner"; name: string }
  | { type: "CreateTask"; taskId: string; runner: string; prompt: string }
  | { type: "CancelTask"; taskId: string };

export type WorldMsg =
  | { type: "Booted"; now: number }
  | { type: "Tick"; now: number }
  | { type: "RunnerOk"; name: string; agent?: AgentInfo }
  | { type: "RunnerFailed"; name: string; error: string }
  | { type: "Dispatched"; taskId: string; snapshot: TaskSnapshot }
  | { type: "DispatchFailed"; taskId: string; error: string }
  | { type: "TaskSnapshot"; taskId: string; snapshot: TaskSnapshot }
  | { type: "TaskUpdated"; taskId: string; update: TaskUpdate }
  | { type: "SyncFailed"; taskId: string; error: string }
  | { type: "StreamDropped"; taskId: string; epoch: number; error: string | null }
  | { type: "CancelFailed"; taskId: string; error: string };

export type Msg = IntentMsg | WorldMsg;

export type RunnerRef = { name: string; url: string; token: string };

export type Effect =
  | { type: "CheckRunner"; runner: RunnerRef }
  | { type: "Dispatch"; taskId: string; runner: RunnerRef; prompt: string }
  | { type: "GetTask"; taskId: string; runner: RunnerRef; remoteId: string }
  | { type: "Cancel"; taskId: string; runner: RunnerRef; remoteId: string };

export type Sub = {
  type: "TaskStream";
  key: string;
  taskId: string;
  epoch: number;
  runner: RunnerRef;
  remoteId: string;
};

export const INTENT_TYPES: ReadonlySet<string> = new Set<IntentMsg["type"]>([
  "AddRunner",
  "RemoveRunner",
  "CreateTask",
  "CancelTask",
]);
