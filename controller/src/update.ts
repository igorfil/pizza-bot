import type {
  AgentInfo,
  Effect,
  Model,
  Msg,
  Notification,
  Runner,
  RunnerRef,
  Sub,
  Task,
  TaskSnapshot,
  TaskState,
  TaskUpdate,
} from "./types.ts";

export const TICK_MS = 2_000;
export const HEALTH_INTERVAL_MS = 15_000;
export const RESYNC_MS = 30_000;
export const WAKE_GAP_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_NOTIFICATIONS = 20;

export type Result = [Model, Effect[]];

export const initialModel = (): Model => ({ now: 0, runners: {}, tasks: {}, notifications: [] });

const TERMINAL: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled", "rejected", "lost"]);

export const isTerminal = (task: Task): boolean => TERMINAL.has(task.state);

export const backoffMs = (failures: number): number =>
  Math.min(1000 * 2 ** Math.max(failures - 1, 0), MAX_BACKOFF_MS);

const ref = (r: Runner): RunnerRef => ({ name: r.name, url: r.url, token: r.token });

const notify = (model: Model, level: Notification["level"], text: string): Model => ({
  ...model,
  notifications: [...model.notifications, { at: model.now, level, text }].slice(-MAX_NOTIFICATIONS),
});

const setTask = (model: Model, task: Task): Model => ({
  ...model,
  tasks: { ...model.tasks, [task.id]: { ...task, updatedAt: model.now } },
});

const setRunner = (model: Model, runner: Runner): Model => ({
  ...model,
  runners: { ...model.runners, [runner.name]: runner },
});

const isSyncable = (task: Task): task is Task & { remoteId: string } =>
  !isTerminal(task) && task.remoteId !== null;

const getTaskEffect = (model: Model, task: Task & { remoteId: string }): Effect[] => {
  const runner = model.runners[task.runner];
  return runner ? [{ type: "GetTask", taskId: task.id, runner: ref(runner), remoteId: task.remoteId }] : [];
};

const applySnapshot = (task: Task, snapshot: TaskSnapshot, now: number): Task => ({
  ...task,
  remoteId: snapshot.remoteId,
  state: snapshot.state,
  statusText: snapshot.statusText,
  artifacts: snapshot.artifacts,
  lastSyncAt: now,
});

const upsertArtifact = (task: Task, artifact: TaskUpdate["artifact"]): Task["artifacts"] =>
  artifact === undefined
    ? task.artifacts
    : [...task.artifacts.filter((a) => a.id !== artifact.id), artifact];

const applyUpdate = (task: Task, update: TaskUpdate): Task => ({
  ...task,
  state: update.state ?? task.state,
  statusText: update.statusText !== undefined ? update.statusText : task.statusText,
  artifacts: upsertArtifact(task, update.artifact),
  streamFailures: 0,
});

/**
 * Used on boot and on wake. Runners drop to `unknown`, which closes every stream; the
 * health check that follows brings them back via `RunnerOk`, which re-fetches their tasks.
 */
const resyncAll = (model: Model): Result => {
  const runners = Object.fromEntries(
    Object.values(model.runners).map((r) => [
      r.name,
      { ...r, status: "unknown" as const, nextCheckAt: model.now + HEALTH_INTERVAL_MS },
    ]),
  );
  const tasks = Object.fromEntries(
    Object.values(model.tasks).map((t) => [
      t.id,
      isSyncable(t) ? { ...t, streamEpoch: t.streamEpoch + 1, streamFailures: 0, streamRetryAt: 0 } : t,
    ]),
  );
  const effects = Object.values(model.runners).map((r): Effect => ({ type: "CheckRunner", runner: ref(r) }));
  return [{ ...model, runners, tasks }, effects];
};

const markLostDispatches = (model: Model): Model =>
  Object.values(model.tasks)
    .filter((t) => t.state === "dispatching")
    .reduce(
      (m, t) => setTask(m, { ...t, state: "lost", statusText: "controller restarted during dispatch" }),
      model,
    );

const dueRunnerChecks = (model: Model): Result => {
  const due = Object.values(model.runners).filter((r) => r.nextCheckAt <= model.now);
  const next = due.reduce((m, r) => setRunner(m, { ...r, nextCheckAt: m.now + HEALTH_INTERVAL_MS }), model);
  return [next, due.map((r): Effect => ({ type: "CheckRunner", runner: ref(r) }))];
};

const dueResyncs = (model: Model): Result => {
  const due = Object.values(model.tasks)
    .filter(isSyncable)
    .filter((t) => model.now - t.lastSyncAt >= RESYNC_MS && model.runners[t.runner]?.status === "healthy");
  const next = due.reduce((m, t) => setTask(m, { ...t, lastSyncAt: m.now }), model);
  return [next, due.flatMap((t) => getTaskEffect(model, t))];
};

const tick = (model: Model, now: number): Result => {
  const woke = model.now !== 0 && now - model.now > WAKE_GAP_MS;
  const ticked = { ...model, now };
  const [afterWake, wakeEffects] = woke ? resyncAll(notify(ticked, "info", "wake detected, resyncing")) : [ticked, []];
  const [afterChecks, checkEffects] = dueRunnerChecks(afterWake);
  const [afterResync, resyncEffects] = dueResyncs(afterChecks);
  return [afterResync, [...wakeEffects, ...checkEffects, ...resyncEffects]];
};

const runnerFailed = (model: Model, name: string, error: string): Model => {
  const runner = model.runners[name];
  if (!runner) return model;
  const failures = runner.failures + 1;
  const updated = setRunner(model, {
    ...runner,
    status: "unreachable",
    failures,
    lastError: error,
    nextCheckAt: model.now + backoffMs(failures),
  });
  return runner.status === "unreachable" ? updated : notify(updated, "error", `runner ${name} unreachable: ${error}`);
};

const runnerOk = (model: Model, name: string, agent: AgentInfo | undefined): Result => {
  const runner = model.runners[name];
  if (!runner) return [model, []];
  const recovered = runner.status !== "healthy";
  const updated = setRunner(model, {
    ...runner,
    status: "healthy",
    failures: 0,
    lastError: null,
    lastSeenAt: model.now,
    nextCheckAt: model.now + HEALTH_INTERVAL_MS,
    agent: agent ?? runner.agent ?? null,
  });
  const catchUp = recovered
    ? Object.values(model.tasks)
        .filter(isSyncable)
        .filter((t) => t.runner === name)
        .flatMap((t) => getTaskEffect(updated, t))
    : [];
  return [recovered ? notify(updated, "info", `runner ${name} healthy`) : updated, catchUp];
};

const withTask = (model: Model, taskId: string, f: (task: Task) => Result): Result => {
  const task = model.tasks[taskId];
  return task ? f(task) : [model, []];
};

export const update = (model: Model, msg: Msg): Result => {
  switch (msg.type) {
    case "AddRunner": {
      if (model.runners[msg.name]) return [notify(model, "error", `runner ${msg.name} already exists`), []];
      const runner: Runner = {
        name: msg.name,
        url: msg.url.replace(/\/+$/, ""),
        token: msg.token,
        status: "unknown",
        failures: 0,
        nextCheckAt: model.now + HEALTH_INTERVAL_MS,
        lastSeenAt: null,
        lastError: null,
        agent: null,
      };
      return [notify(setRunner(model, runner), "info", `runner ${msg.name} added`), [{ type: "CheckRunner", runner: ref(runner) }]];
    }

    case "RemoveRunner": {
      const { [msg.name]: _removed, ...runners } = model.runners;
      return [{ ...model, runners }, []];
    }

    case "CreateTask": {
      const runner = model.runners[msg.runner];
      if (!runner) return [notify(model, "error", `unknown runner ${msg.runner}`), []];
      const task: Task = {
        id: msg.taskId,
        runner: msg.runner,
        prompt: msg.prompt,
        remoteId: null,
        state: "dispatching",
        statusText: null,
        artifacts: [],
        createdAt: model.now,
        updatedAt: model.now,
        lastSyncAt: model.now,
        streamEpoch: 0,
        streamFailures: 0,
        streamRetryAt: 0,
      };
      return [setTask(model, task), [{ type: "Dispatch", taskId: task.id, runner: ref(runner), prompt: msg.prompt }]];
    }

    case "CancelTask":
      return withTask(model, msg.taskId, (task) => {
        const runner = model.runners[task.runner];
        if (!isSyncable(task) || !runner) return [notify(model, "error", `task ${task.id} cannot be canceled`), []];
        return [model, [{ type: "Cancel", taskId: task.id, runner: ref(runner), remoteId: task.remoteId }]];
      });

    case "Booted":
      return resyncAll(markLostDispatches({ ...model, now: msg.now }));

    case "Tick":
      return tick(model, msg.now);

    case "RunnerOk":
      return runnerOk(model, msg.name, msg.agent);

    case "RunnerFailed":
      return [runnerFailed(model, msg.name, msg.error), []];

    case "Dispatched":
    case "TaskSnapshot":
      return withTask(model, msg.taskId, (task) => [setTask(model, applySnapshot(task, msg.snapshot, model.now)), []]);

    case "DispatchFailed":
      return withTask(model, msg.taskId, (task) => [
        notify(setTask(model, { ...task, state: "failed", statusText: msg.error }), "error", `dispatch failed: ${msg.error}`),
        [],
      ]);

    case "TaskUpdated":
      return withTask(model, msg.taskId, (task) =>
        isTerminal(task) ? [model, []] : [setTask(model, applyUpdate(task, msg.update)), []],
      );

    case "SyncFailed":
      // Only health checks drive backoff; a failed fetch just asks for an early check.
      return withTask(model, msg.taskId, (task) => {
        const runner = model.runners[task.runner];
        if (!runner || runner.status !== "healthy") return [model, []];
        return [setRunner(model, { ...runner, status: "unknown", lastError: msg.error, nextCheckAt: model.now }), []];
      });

    case "StreamDropped":
      return withTask(model, msg.taskId, (task) => {
        if (msg.epoch !== task.streamEpoch || !isSyncable(task)) return [model, []];
        const failures = task.streamFailures + 1;
        const next = setTask(model, {
          ...task,
          streamEpoch: task.streamEpoch + 1,
          streamFailures: failures,
          streamRetryAt: model.now + backoffMs(failures),
        });
        return [next, getTaskEffect(next, task)];
      });

    case "CancelFailed":
      return [notify(model, "error", `cancel ${msg.taskId} failed: ${msg.error}`), []];
  }
};

export const subscriptions = (model: Model): Sub[] =>
  Object.values(model.tasks)
    .filter(isSyncable)
    .filter((t) => model.now >= t.streamRetryAt)
    .flatMap((t): Sub[] => {
      const runner = model.runners[t.runner];
      return runner?.status === "healthy"
        ? [{ type: "TaskStream", key: `${t.id}#${t.streamEpoch}`, taskId: t.id, epoch: t.streamEpoch, runner: ref(runner), remoteId: t.remoteId }]
        : [];
    });
