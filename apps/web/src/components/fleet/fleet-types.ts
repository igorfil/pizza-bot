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
  /** Display name; `name` stays the id agent keys and intents use. */
  label?: string | null;
  transport: "direct" | "aws_ssm" | "ssh" | "plugin";
  /** How a `plugin` transport names itself, e.g. "SSH via a dev box". */
  transportLabel?: string;
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
  /** The runner can create prompt agents (CreateAgent). */
  canCreateAgents?: boolean;
  /** Harnesses the runner offers; `pizza-bot` lets created agents have MCP servers and skills. */
  harnesses?: string[];
  /** Harness plugins that run its external agents, with their last health check. */
  plugins?: FleetPlugin[];
  /** Plugin id → its `icon.svg` markup; shown only as an image. */
  pluginIcons?: Record<string, string>;
  /** The MCP servers on the runner's machine, which its agents pick from. */
  mcpServers?: Record<string, Record<string, unknown>>;
  agentsChange?: FleetAgentsChange | null;
}

export interface FleetPlugin {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  healthy: boolean;
  detail: string;
  /** What Add existing asks for; only plugins with the `add` capability have them. */
  addFields?: FleetAddField[];
}

/** `path`: a folder on the runner's machine; `list`: comma-separated words. */
export interface FleetAddField {
  id: string;
  label: string;
  kind: "text" | "path" | "list";
  required?: boolean;
  hint?: string;
  placeholder?: string;
}

/** In flight while `error` is null. */
export type FleetAgentsChange = { action: "add" | "remove" | "edit"; agents: string[]; error: string | null };

/** What users run, schedule and see. Key: `<runner>/<id>`. */
export interface FleetAgent {
  key: string;
  runner: string;
  id: string;
  name: string;
  description: string;
  input: { label: string; hint: string; example: string } | null;
  schedule: { at: string; prompt: string } | null;
  /** `builtin`: on the runner's own engine, which configures it; `external`: brings its own tools. */
  kind?: "builtin" | "external";
  /** The runner harness that runs it; `pizza-bot` agents remember a conversation across follow-ups. */
  harness?: string | null;
  /** Made with Create new; deleting it deletes it. */
  created?: boolean;
  /** Added through a plugin from Add existing; deleting it removes it from the plugin. */
  added?: boolean;
  /** Only on created agents, for editing. */
  model?: string;
  systemPrompt?: string;
  /** Ids of the runner's MCP servers the agent uses. */
  mcp?: string[];
  /** The skills the agent holds copies of; only on created agents. */
  skills?: { id: string; name: string; description: string }[];
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
  /** The conversation the run belongs to; a follow-up continues it. */
  contextId?: string | null;
  /** The run this one follows up on. */
  followUpOf?: string | null;
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
