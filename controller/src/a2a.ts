import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { Role, TaskState as A2AState, type Artifact as A2AArtifact, type Part, type StreamResponse, type Task as A2ATask, type TaskStatus } from "@a2a-js/sdk";
import type { AgentInfo, Artifact, RunnerRef, TaskSnapshot, TaskUpdate } from "./types.ts";

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
const clientFor = async (runner: RunnerRef): Promise<Client> => {
  const cached = clients.get(runner.url);
  if (cached) return cached;
  const client = await factory.createFromUrl(runner.url);
  clients.set(runner.url, client);
  return client;
};

const auth = (runner: RunnerRef) => ({ Authorization: `Bearer ${runner.token}` });

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const attempt = async <T>(f: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
};

type CardJson = { description?: unknown; skills?: { name?: unknown; description?: unknown; examples?: unknown }[] };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const toAgentInfo = (card: CardJson): AgentInfo => {
  const skill = card.skills?.[0];
  return {
    description: str(card.description),
    examples: (card.skills ?? []).flatMap((s) =>
      Array.isArray(s.examples) ? s.examples.filter((e): e is string => typeof e === "string") : [],
    ),
    input: skill ? { label: str(skill.name), hint: str(skill.description) } : null,
  };
};

export const checkRunner = (runner: RunnerRef): Promise<Outcome<AgentInfo>> =>
  attempt(async () => {
    const res = await fetch(`${runner.url}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`agent card: HTTP ${res.status}`);
    return toAgentInfo((await res.json()) as CardJson);
  });

const asTask = (result: unknown): A2ATask => {
  if (result && typeof result === "object" && "status" in result) return result as A2ATask;
  throw new Error("agent replied with a message, not a task");
};

export const dispatch = (runner: RunnerRef, prompt: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(runner);
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
      { serviceParameters: auth(runner), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(asTask(result));
  });

export const getTask = (runner: RunnerRef, remoteId: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(runner);
    const task = await client.getTask(
      { tenant: "", id: remoteId },
      { serviceParameters: auth(runner), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(task);
  });

export const cancel = (runner: RunnerRef, remoteId: string): Promise<Outcome<TaskSnapshot>> =>
  attempt(async () => {
    const client = await clientFor(runner);
    const task = await client.cancelTask(
      { tenant: "", id: remoteId, metadata: undefined },
      { serviceParameters: auth(runner), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    return toSnapshot(task);
  });

/** Resolves when the stream ends; `null` for a clean end, otherwise the error text. */
export const stream = async (
  runner: RunnerRef,
  remoteId: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<string | null> => {
  const result = await attempt(async () => {
    const client = await clientFor(runner);
    for await (const event of client.resubscribeTask({ tenant: "", id: remoteId }, { serviceParameters: auth(runner), signal })) {
      const mapped = toStreamEvent(event);
      if (mapped) onEvent(mapped);
    }
  });
  return result.ok ? null : result.error;
};
