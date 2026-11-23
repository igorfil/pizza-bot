import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { Role, TaskState as A2AState, type Artifact as A2AArtifact, type Part, type StreamResponse, type Task as A2ATask, type TaskStatus } from "@a2a-js/sdk";
import { attempt, type Outcome } from "./outcome.js";
import type { AgentInfo, Artifact, TaskSnapshot, TaskUpdate } from "./types.js";

/** One agent behind a runner link, with its token already read from the vault. */
export type AgentEndpoint = { url: string; token: string };

const CALL_TIMEOUT_MS = 10_000;

const STATE: Partial<Record<A2AState, TaskSnapshot["state"]>> = {
  [A2AState.TASK_STATE_SUBMITTED]: "submitted",
  [A2AState.TASK_STATE_WORKING]: "working",
  [A2AState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [A2AState.TASK_STATE_AUTH_REQUIRED]: "input-required",
  [A2AState.TASK_STATE_COMPLETED]: "completed",
  [A2AState.TASK_STATE_FAILED]: "failed",
  [A2AState.TASK_STATE_CANCELED]: "canceled",
  [A2AState.TASK_STATE_REJECTED]: "rejected",
};

const toState = (state: A2AState | undefined): TaskSnapshot["state"] =>
  (state !== undefined && STATE[state]) || "submitted";

const partsText = (parts: Part[]): string =>
  parts
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .filter((t) => t.length > 0)
    .join("\n");

const statusText = (status: TaskStatus | undefined): string | null =>
  status?.message ? partsText(status.message.parts) || null : null;

const toArtifact = (a: A2AArtifact): Artifact => ({ id: a.artifactId, name: a.name, text: partsText(a.parts) });

export const toSnapshot = (task: A2ATask): TaskSnapshot => ({
  remoteId: task.id,
  state: toState(task.status?.state),
  statusText: statusText(task.status),
  artifacts: task.artifacts.map(toArtifact),
});

export type StreamEvent = { kind: "snapshot"; snapshot: TaskSnapshot } | { kind: "update"; update: TaskUpdate };

export const toStreamEvent = (event: StreamResponse): StreamEvent | null => {
  const p = event.payload;
  switch (p?.$case) {
    case "task":
      return { kind: "snapshot", snapshot: toSnapshot(p.value) };
    case "statusUpdate":
      return { kind: "update", update: { state: toState(p.value.status?.state), statusText: statusText(p.value.status) } };
    case "artifactUpdate":
      return p.value.artifact ? { kind: "update", update: { artifact: toArtifact(p.value.artifact) } } : null;
    default:
      return null;
  }
};

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { transports: [new JsonRpcTransportFactory()] }),
);

const resolver = new DefaultAgentCardResolver();

/** Keyed by URL, which includes a tunnel's local port: a reopened link gets a fresh client. */
const clients = new Map<string, Client>();

/**
 * The card says what the agent is; where to call it is always `<runner link>/agents/<id>/jsonrpc`.
 * The card's own interface URL can't know a tunnel's local port.
 * @throws when the agent card cannot be fetched
 */
const clientFor = async (endpoint: AgentEndpoint): Promise<Client> => {
  const cached = clients.get(endpoint.url);
  if (cached) return cached;
  // A relative card path keeps the `/agents/<id>` prefix; the SDK's default is absolute and would drop it.
  const card = await resolver.resolve(`${endpoint.url}/`, ".well-known/agent-card.json");
  const pinned = { ...card, supportedInterfaces: card.supportedInterfaces.map((i) => ({ ...i, url: `${endpoint.url}/jsonrpc` })) };
  const client = await factory.createFromAgentCard(pinned);
  clients.set(endpoint.url, client);
  return client;
};

const auth = (endpoint: AgentEndpoint) => ({ Authorization: `Bearer ${endpoint.token}` });

type IndexJson = {
  location?: unknown;
  available?: NonNullable<IndexJson["agents"]>;
  agents?: { id?: unknown; name?: unknown; description?: unknown; input?: { label?: unknown; hint?: unknown; example?: unknown } | null }[];
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const toAgentInfo = (a: NonNullable<IndexJson["agents"]>[number]): AgentInfo | null =>
  str(a.id)
    ? {
        id: str(a.id),
        name: str(a.name) || str(a.id),
        description: str(a.description),
        input: a.input ? { label: str(a.input.label), hint: str(a.input.hint), example: str(a.input.example) } : null,
      }
    : null;

export type RunnerIndex = { agents: AgentInfo[]; location: string | null; available: AgentInfo[] | null };

const infos = (list: IndexJson["agents"]): AgentInfo[] => (list ?? []).map(toAgentInfo).filter((a): a is AgentInfo => a !== null);

/** A runner without `available` predates `PUT /agents`, so its agents can't be changed from here. */
const toIndex = (index: IndexJson): RunnerIndex => ({
  agents: infos(index.agents),
  location: str(index.location) || null,
  available: Array.isArray(index.available) ? infos(index.available) : null,
});

/** The runner's `GET /agents` is both discovery and its health check. */
export const checkRunner = (url: string): Promise<Outcome<RunnerIndex>> =>
  attempt(async () => {
    const res = await fetch(`${url}/agents`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`runner index: HTTP ${res.status}`);
    return toIndex((await res.json()) as IndexJson);
  });

/** Replaces the agents the runner serves; it answers with its new index. */
export const setAgents = (url: string, token: string, agents: string[]): Promise<Outcome<RunnerIndex>> =>
  attempt(async () => {
    const res = await fetch(`${url}/agents`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agents }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as IndexJson & { error?: unknown };
    if (res.status === 404 || res.status === 405) throw new Error("this runner can't change its agents; update the runner");
    if (!res.ok) throw new Error(str(body.error) || `HTTP ${res.status}`);
    return toIndex(body);
  });

const asTask = (result: unknown): A2ATask => {
  if (result && typeof result === "object" && "status" in result) return result as A2ATask;
  throw new Error("agent replied with a message, not a task");
};

export const dispatch = (endpoint: AgentEndpoint, prompt: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(endpoint);
    const result = await client.sendMessage(
      {
        tenant: "",
        metadata: undefined,
        message: {
          messageId: crypto.randomUUID(),
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: [{ content: { $case: "text", value: prompt }, metadata: undefined, filename: "", mediaType: "text/plain" }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: {
          acceptedOutputModes: [],
          taskPushNotificationConfig: undefined,
          returnImmediately: true,
        },
      },
      { serviceParameters: auth(endpoint), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(asTask(result));
  });

export const getTask = (endpoint: AgentEndpoint, remoteId: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(endpoint);
    const task = await client.getTask(
      { tenant: "", id: remoteId },
      { serviceParameters: auth(endpoint), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(task);
  });

export const cancel = (endpoint: AgentEndpoint, remoteId: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(endpoint);
    const task = await client.cancelTask(
      { tenant: "", id: remoteId, metadata: undefined },
      { serviceParameters: auth(endpoint), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(task);
  });

/** Resolves when the stream ends; `null` for a clean end, otherwise the error text. */
export const stream = async (
  endpoint: AgentEndpoint,
  remoteId: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<string | null> => {
  const result = await attempt(async () => {
    const client = await clientFor(endpoint);
    for await (const event of client.resubscribeTask({ tenant: "", id: remoteId }, { serviceParameters: auth(endpoint), signal })) {
      const mapped = toStreamEvent(event);
      if (mapped) onEvent(mapped);
    }
  });
  return result.ok ? null : result.error;
};
