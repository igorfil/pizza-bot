export type RunnerStatus = "unknown" | "healthy" | "unreachable";

/** `inline` only appears in Msg logs written before the vault existed. */
export type SecretRef = { kind: "vault"; key: string } | { kind: "inline"; value: string };

export type AwsCredentials =
  | { kind: "default" }
  | { kind: "profile"; profile: string }
  | { kind: "keys"; accessKeyId: SecretRef; secretAccessKey: SecretRef };

/** How the Controller reaches a runner; `transport.ts` turns it into a live Transport. */
export type TransportSpec =
  | { kind: "direct"; url: string }
  | { kind: "aws_ssm"; region: string; instanceId: string; remotePort: number; credentials: AwsCredentials }
  | SshTransport;

/** Auth is the system ssh's: ~/.ssh/config, ssh-agent, known_hosts; null fields defer to them. */
export type SshTransport = {
  kind: "ssh";
  host: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  remotePort: number;
};

/** Which guide made the runner, and what removing it can also undo. */
export type RunnerOrigin = {
  guide: string;
  summary: string;
  teardown: { label: string; data: Record<string, string> } | null;
};

/** A runner as a guide (or `AddRunner`) hands it over. */
export type NewRunner = { name: string; transport: TransportSpec; token: SecretRef; origin: RunnerOrigin | null };

export type Link = { state: "down"; error: string | null } | { state: "up"; url: string };

export type AgentInput = { label: string; hint: string; example: string };

/** What a runner's `GET /agents` reports for one agent. */
export type AgentInfo = { id: string; name: string; description: string; input: AgentInput | null };

/** A host process: one per machine. Health and reconnect are per runner; the link comes first. */
export type Runner = NewRunner & {
  link: Link;
  linkEpoch: number;
  linkFailures: number;
  linkRetryAt: number;
  status: RunnerStatus;
  failures: number;
  nextCheckAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
  location: string | null;
  /** Agents on the runner's disk it doesn't serve yet; null when the runner can't change its agents. */
  available: AgentInfo[] | null;
  /** The last AddAgents for this runner, until it lands or a new one starts. */
  agentsChange: AgentsChange | null;
};

export type AgentsChange = { state: "adding"; agents: string[] } | { state: "failed"; agents: string[]; error: string };

/** An agent hosted by a runner; the unit users run, schedule and see. Key: `<runner>/<id>`. */
export type Agent = AgentInfo & {
  key: string;
  runner: string;
  /** Daily run at local `at` (HH:MM). Fires once per local day, on the first tick at or after `at`. */
  schedule: { at: string; prompt: string } | null;
  lastScheduledDay: string | null;
};

export type TaskState =
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
  trigger: "manual" | "schedule";
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

/** One question or progress screen of a guide; UIs render it generically. */
export type StepField = {
  id: string;
  label: string;
  hint?: string;
  kind: "text" | "secret" | "choice";
  value?: string;
  options?: { value: string; label: string; detail?: string; disabled?: boolean }[];
};

/** `steps` places the screen in the guide's overall flow, for a stepper. */
export type StepView = { title: string; body?: string; progress?: string; fields: StepField[]; submit?: string; steps?: { labels: string[]; current: number } };

/** A guide's own progress; plain JSON, logged, so it must never hold a secret (only vault keys). */
export type GuideState = Record<string, unknown>;

/** Field values by id; a `secret` field's value is the vault key the API stored it under. */
export type GuideInput = Record<string, string>;

export type GuideResult =
  | { kind: "ask"; state: GuideState; view: StepView; error?: string }
  | { kind: "working"; state: GuideState; view: StepView }
  | { kind: "done"; runner: NewRunner }
  | { kind: "failed"; state: GuideState; view: StepView; error: string };

export type GuideInfo = { id: string; title: string; description: string };

export type GuideSession = {
  id: string;
  guide: string;
  status: "ask" | "working" | "failed";
  state: GuideState | null;
  view: StepView;
  error: string | null;
  /** Vault keys of secrets typed into this session; the unused ones are deleted when it ends. */
  secretKeys: string[];
  createdAt: number;
  updatedAt: number;
};

export type Model = {
  now: number;
  runners: Record<string, Runner>;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  chats: Record<string, Chat>;
  guideSessions: Record<string, GuideSession>;
  guideCatalog: GuideInfo[];
  notifications: Notification[];
  /** Last local clock seen in a Tick; lets SetSchedule tell whether today's slot already passed. */
  local: LocalClock | null;
};

/** Runtime-neutral view of a remote task. The A2A adapter maps into this. */
export type TaskSnapshot = {
  remoteId: string;
  state: Exclude<TaskState, "queued" | "dispatching" | "lost">;
  statusText: string | null;
  artifacts: Artifact[];
};

export type TaskUpdate = {
  state?: TaskSnapshot["state"];
  statusText?: string | null;
  artifact?: Artifact;
};

export type IntentMsg =
  | ({ type: "AddRunner" } & NewRunner)
  | { type: "UpdateRunner"; name: string; transport: TransportSpec | null; token: SecretRef | null }
  | { type: "RemoveRunner"; name: string; teardown: boolean }
  | { type: "AddAgents"; runner: string; agents: string[] }
  | { type: "CreateTask"; taskId: string; agent: string; prompt: string }
  | { type: "CancelTask"; taskId: string }
  | { type: "AckInbox"; taskId: string }
  | { type: "AckAllInbox" }
  | { type: "CreateChat"; chatId: string; fromTaskId: string | null; text: string }
  | { type: "SendChatMessage"; chatId: string; text: string }
  | { type: "SetSchedule"; agent: string; at: string | null; prompt: string }
  | { type: "StartGuide"; sessionId: string; guide: string }
  | { type: "GuideInput"; sessionId: string; input: GuideInput }
  | { type: "GuideRetry"; sessionId: string }
  | { type: "CancelGuide"; sessionId: string };

/** Local calendar position, computed by the runtime so `update` stays pure. */
export type LocalClock = { day: string; minute: number };

export type WorldMsg =
  | { type: "Booted"; now: number; guides: GuideInfo[] }
  | { type: "Tick"; now: number; local?: LocalClock }
  | { type: "LinkUp"; runner: string; epoch: number; url: string }
  | { type: "LinkDown"; runner: string; epoch: number; error: string | null }
  | { type: "RunnerOk"; name: string; agents: AgentInfo[]; location: string | null; available: AgentInfo[] | null }
  | { type: "AgentsSet"; runner: string; added: string[]; agents: AgentInfo[]; location: string | null; available: AgentInfo[] | null }
  | { type: "AgentsSetFailed"; runner: string; error: string }
  | { type: "RunnerFailed"; name: string; error: string }
  | { type: "RunnerRetired"; name: string; text: string; ok: boolean }
  | { type: "Dispatched"; taskId: string; snapshot: TaskSnapshot }
  | { type: "DispatchFailed"; taskId: string; error: string }
  | { type: "TaskSnapshot"; taskId: string; snapshot: TaskSnapshot }
  | { type: "TaskUpdated"; taskId: string; update: TaskUpdate }
  | { type: "SyncFailed"; taskId: string; error: string }
  | { type: "StreamDropped"; taskId: string; epoch: number; error: string | null }
  | { type: "CancelFailed"; taskId: string; error: string }
  | { type: "ChatReplied"; chatId: string; text: string }
  | { type: "ChatFailed"; chatId: string; error: string }
  | { type: "GuideStepped"; sessionId: string; result: GuideResult };

export type Msg = IntentMsg | WorldMsg;

/** Where to reach one agent over A2A: always through its runner, `<link url>/agents/<id>`. */
export type Endpoint = { url: string; token: SecretRef };

export type LlmTurn = { role: ChatRole; text: string };

export type Effect =
  | { type: "CheckRunner"; runner: string; url: string }
  | { type: "SetRunnerAgents"; runner: string; endpoint: Endpoint; agents: string[]; added: string[] }
  | { type: "Dispatch"; taskId: string; endpoint: Endpoint; prompt: string }
  | { type: "GetTask"; taskId: string; endpoint: Endpoint; remoteId: string }
  | { type: "Cancel"; taskId: string; endpoint: Endpoint; remoteId: string }
  | { type: "ChatComplete"; chatId: string; system: string; turns: LlmTurn[] }
  | { type: "RunGuideStep"; sessionId: string; guide: string; state: GuideState | null; input: GuideInput | null }
  | { type: "DeleteSecrets"; keys: string[] }
  | { type: "RetireRunner"; runner: NewRunner; teardown: boolean };

export type Sub =
  | { type: "TaskStream"; key: string; taskId: string; epoch: number; endpoint: Endpoint; remoteId: string }
  | { type: "Link"; key: string; runner: string; epoch: number; transport: TransportSpec };

export const INTENT_TYPES: ReadonlySet<string> = new Set<IntentMsg["type"]>([
  "AddRunner",
  "UpdateRunner",
  "RemoveRunner",
  "AddAgents",
  "CreateTask",
  "CancelTask",
  "AckInbox",
  "AckAllInbox",
  "CreateChat",
  "SendChatMessage",
  "SetSchedule",
  "StartGuide",
  "GuideInput",
  "GuideRetry",
  "CancelGuide",
]);
