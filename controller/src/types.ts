export type RunnerStatus = "unknown" | "healthy" | "unreachable";

export type AgentInput = { label: string; hint: string; example: string };

/** What a runner's `GET /agents` reports for one agent. */
export type AgentInfo = { id: string; name: string; description: string; input: AgentInput | null };

/** A host process: one per machine. Health and reconnect are per runner. */
export type Runner = {
  name: string;
  url: string;
  token: string;
  status: RunnerStatus;
  failures: number;
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  location: string | null;
};

/** An agent hosted by a runner; the unit users run, schedule and see. Key: `<runner>/<id>`. */
export type Agent = AgentInfo & {
  key: string;
  runner: string;
  /** Daily run at local `at` (HH:MM). Fires once per local day, on the first tick at or after `at`. */
  schedule: { at: string; prompt: string } | null;
  lastScheduledDay: string | null;
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
  /** Agent id within the runner; the agent's key is `${runner}/${agent}`. */
  agent: string;
  prompt: string;
  remoteId: string | null;
  state: TaskState;
  statusText: string | null;
  artifacts: Artifact[];
  createdAt: number;
  updatedAt: number;
  trigger?: "manual" | "schedule";
  /** Set once the user has dealt with the finished run in the inbox. */
  ackedAt: number | null;
  lastSyncAt: number;
  streamEpoch: number;
  streamFailures: number;
  streamRetryAt: number;
};

export type Notification = { at: number; level: "info" | "error"; text: string };

export type ChatRole = "user" | "assistant";

export type ChatMessage = { id: string; role: ChatRole; text: string; at: number };

export type Chat = {
  id: string;
  title: string;
  /** Agent result the chat was started from; sent to the model as background. */
  context: { taskId: string; text: string } | null;
  messages: ChatMessage[];
  pending: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Model = {
  now: number;
  runners: Record<string, Runner>;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  chats: Record<string, Chat>;
  notifications: Notification[];
  /** Last local clock seen in a Tick; lets SetSchedule tell whether today's slot already passed. */
  local: LocalClock | null;
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
  | { type: "CreateTask"; taskId: string; agent: string; prompt: string }
  | { type: "CancelTask"; taskId: string }
  | { type: "AckInbox"; taskId: string }
  | { type: "AckAllInbox" }
  | { type: "CreateChat"; chatId: string; fromTaskId: string | null; text: string }
  | { type: "SendChatMessage"; chatId: string; text: string }
  | { type: "SetSchedule"; agent: string; at: string | null; prompt: string };

/** Local calendar position, computed by the runtime so `update` stays pure. */
export type LocalClock = { day: string; minute: number };

export type WorldMsg =
  | { type: "Booted"; now: number }
  | { type: "Tick"; now: number; local?: LocalClock }
  | { type: "RunnerOk"; name: string; agents: AgentInfo[]; location: string | null }
  | { type: "RunnerFailed"; name: string; error: string }
  | { type: "Dispatched"; taskId: string; snapshot: TaskSnapshot }
  | { type: "DispatchFailed"; taskId: string; error: string }
  | { type: "TaskSnapshot"; taskId: string; snapshot: TaskSnapshot }
  | { type: "TaskUpdated"; taskId: string; update: TaskUpdate }
  | { type: "SyncFailed"; taskId: string; error: string }
  | { type: "StreamDropped"; taskId: string; epoch: number; error: string | null }
  | { type: "CancelFailed"; taskId: string; error: string }
  | { type: "ChatReplied"; chatId: string; text: string }
  | { type: "ChatFailed"; chatId: string; error: string };

export type Msg = IntentMsg | WorldMsg;

export type RunnerRef = { name: string; url: string; token: string };

/** Where to reach one agent over A2A: `<runner url>/agents/<id>`. */
export type Endpoint = { url: string; token: string };

export type LlmTurn = { role: ChatRole; text: string };

export type Effect =
  | { type: "CheckRunner"; runner: RunnerRef }
  | { type: "Dispatch"; taskId: string; endpoint: Endpoint; prompt: string }
  | { type: "GetTask"; taskId: string; endpoint: Endpoint; remoteId: string }
  | { type: "Cancel"; taskId: string; endpoint: Endpoint; remoteId: string }
  | { type: "ChatComplete"; chatId: string; system: string; turns: LlmTurn[] };

export type Sub = {
  type: "TaskStream";
  key: string;
  taskId: string;
  epoch: number;
  endpoint: Endpoint;
  remoteId: string;
};

export const INTENT_TYPES: ReadonlySet<string> = new Set<IntentMsg["type"]>([
  "AddRunner",
  "RemoveRunner",
  "CreateTask",
  "CancelTask",
  "AckInbox",
  "AckAllInbox",
  "CreateChat",
  "SendChatMessage",
  "SetSchedule",
]);
