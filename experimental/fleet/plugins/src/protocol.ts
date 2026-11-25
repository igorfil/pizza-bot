/** The runner's side of a harness plugin, over JSON lines on stdin/stdout (plugins/README.md). */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type Input = { label: string; hint?: string; example?: string };

/** What the runner learns about an agent from `agents`; `added`: added through the plugin, so removing it deletes it. */
export type AgentInfo = { id: string; name: string; description?: string; input?: Input; timeoutSecs?: number; added?: boolean };

/** One thing a UI asks for to add an agent: `path` is a folder on the runner's machine, `list` comma-separated words. */
export type AddField = { id: string; label: string; kind: "text" | "path" | "list"; required?: boolean; hint?: string; placeholder?: string };

/** Adding agents through a plugin: what to ask, and what to do with the answers. */
export interface Adding {
  fields: AddField[];
  /** Resolves to the new agent's id. */
  add(values: Record<string, string>): Promise<Result<string>>;
  remove(agentId: string): Promise<Result<null>>;
}

export type RunEvent = { status: string } | { artifact: { name: string; text: string } } | { error: string };

export type Emit = (event: RunEvent) => void;

export type Task = { taskId: string; contextId: string; agent: string; input: string };

export type Health = { ok: boolean; detail: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = (error: string): Result<never> => ({ ok: false, error });

/** Runs one task until it ends or `signal` aborts it; resolves to why it failed, or null when it succeeded. */
export type Job = (emit: Emit, signal: AbortSignal) => Promise<string | null>;

/** What a plugin implements; `serve` turns it into the protocol. */
export interface Harness {
  name: string;
  version: string;
  capabilities: string[];
  health(): Promise<Health>;
  agents(): Promise<AgentInfo[]>;
  /** Checks the task can start (the agent exists, its settings are usable) and returns the job that runs it. */
  prepare(task: Task): Promise<Result<Job>>;
  /** Present when agents can be added from the Fleet page. */
  adding?: Adding;
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Request = { id: number; method: string; params: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const parseRequest = (line: string): Request | null => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.method !== "string") return null;
  return { id: value.id, method: value.method, params: isRecord(value.params) ? value.params : {} };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const taskOf = (params: Record<string, unknown>): Result<Task> =>
  str(params.taskId) && str(params.agent)
    ? ok({ taskId: str(params.taskId), contextId: str(params.contextId) || str(params.taskId), agent: str(params.agent), input: str(params.input) })
    : fail("run needs taskId and agent");

type Io = { input: Readable; output: Writable };

/** Answers the runner until its end of stdin closes; then cancels every run and waits for them to stop. */
export function serve(harness: Harness, io: Io = { input: process.stdin, output: process.stdout }): Promise<void> {
  const write = (line: object) => io.output.write(`${JSON.stringify(line)}\n`);
  const runs = new Map<string, { controller: AbortController; finished: Promise<void> }>();

  const start = (task: Task, job: Job) => {
    const controller = new AbortController();
    const emit: Emit = (event) => {
      if (!controller.signal.aborted) write({ taskId: task.taskId, ...event });
    };
    const finished = job(emit, controller.signal)
      .catch((e: unknown) => message(e))
      .then((reason) => {
        runs.delete(task.taskId);
        if (reason && !controller.signal.aborted) write({ taskId: task.taskId, error: reason });
        write({ taskId: task.taskId, done: true });
      });
    runs.set(task.taskId, { controller, finished });
  };

  const methods: Record<string, (params: Record<string, unknown>) => Promise<Result<unknown>>> = {
    describe: async () =>
      ok({
        name: harness.name,
        version: harness.version,
        capabilities: harness.adding ? [...harness.capabilities, "add"] : harness.capabilities,
        ...(harness.adding ? { add: { fields: harness.adding.fields } } : {}),
      }),
    health: async () => ok(await harness.health()),
    agents: async () => ok({ agents: await harness.agents() }),
    run: async (params) => {
      const task = taskOf(params);
      if (!task.ok) return task;
      const job = await harness.prepare(task.value);
      if (!job.ok) return job;
      start(task.value, job.value);
      return ok({});
    },
    add: async (params) => {
      if (!harness.adding) return fail(`${harness.name} can't add agents`);
      const raw = isRecord(params.fields) ? params.fields : {};
      const values = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, str(v).trim()]));
      const id = await harness.adding.add(values);
      return id.ok ? ok({ id: id.value }) : id;
    },
    remove: async (params) => (harness.adding ? harness.adding.remove(str(params.agent)) : fail(`${harness.name} can't remove agents`)),
    cancel: async (params) => {
      runs.get(str(params.taskId))?.controller.abort();
      return ok({});
    },
  };

  const handle = async (line: string) => {
    const request = parseRequest(line);
    if (!request) return;
    const method = methods[request.method];
    const result = method ? await method(request.params).catch((e: unknown) => fail(message(e))) : fail(`unknown method ${JSON.stringify(request.method)}`);
    write(result.ok ? { id: request.id, result: result.value } : { id: request.id, error: result.error });
  };

  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  lines.on("line", (line) => void handle(line));
  return new Promise((resolve) => {
    lines.on("close", () => {
      const running = [...runs.values()];
      running.forEach((r) => r.controller.abort());
      void Promise.allSettled(running.map((r) => r.finished)).then(() => resolve());
    });
  });
}
