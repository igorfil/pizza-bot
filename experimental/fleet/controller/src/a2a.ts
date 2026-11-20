import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { Role, TaskState as A2AState, type Artifact as A2AArtifact, type Part, type StreamResponse, type Task as A2ATask, type TaskStatus } from "@a2a-js/sdk";
import type { AgentInfo, Artifact, Endpoint, RunnerRef, TaskSnapshot, TaskUpdate } from "./types.js";

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

const clients = new Map<string, Client>();

/** @throws when the agent card cannot be fetched */
const clientFor = async (endpoint: Endpoint): Promise<Client> => {
  const cached = clients.get(endpoint.url);
  if (cached) return cached;
  // A relative card path keeps the `/agents/<id>` prefix; the SDK's default is absolute and would drop it.
  const client = await factory.createFromUrl(`${endpoint.url}/`, ".well-known/agent-card.json");
  clients.set(endpoint.url, client);
  return client;
};

const auth = (endpoint: Endpoint) => ({ Authorization: `Bearer ${endpoint.token}` });

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const attempt = async <T>(f: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
};

type IndexJson = {
  location?: unknown;
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

export type RunnerIndex = { agents: AgentInfo[]; location: string | null };

/** The runner's `GET /agents` is both discovery and its health check. */
export const checkRunner = (runner: RunnerRef): Promise<Outcome<RunnerIndex>> =>
  attempt(async () => {
    const res = await fetch(`${runner.url}/agents`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`runner index: HTTP ${res.status}`);
    const index = (await res.json()) as IndexJson;
    return {
      agents: (index.agents ?? []).map(toAgentInfo).filter((a): a is AgentInfo => a !== null),
      location: str(index.location) || null,
    };
  });

const asTask = (result: unknown): A2ATask => {
  if (result && typeof result === "object" && "status" in result) return result as A2ATask;
  throw new Error("agent replied with a message, not a task");
};

export const dispatch = (endpoint: Endpoint, prompt: string): Promise<Outcome<TaskSnapshot>> =>
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

export const getTask = (endpoint: Endpoint, remoteId: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(endpoint);
    const task = await client.getTask(
      { tenant: "", id: remoteId },
      { serviceParameters: auth(endpoint), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(task);
  });

export const cancel = (endpoint: Endpoint, remoteId: string): Promise<Outcome<TaskSnapshot>> =>
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
  endpoint: Endpoint,
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
