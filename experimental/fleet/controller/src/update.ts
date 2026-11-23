import { chatFailed, chatReplied, createChat, failInterruptedChats, sendChatMessage } from "./chat.js";
import { cancelGuide, guideInput, guideRetry, guideStepped, interruptGuides, startGuide } from "./guide-session.js";
import { addRunner, notify, runnerSpec, setRunner, vaultKeys } from "./runners.js";
import type {
  Agent,
  AgentInfo,
  Effect,
  Endpoint,
  LocalClock,
  Model,
  Msg,
  NewAgentSpec,
  NewRunner,
  Runner,
  SecretRef,
  Sub,
  Task,
  TaskSnapshot,
  TaskState,
  TaskUpdate,
  TransportSpec,
} from "./types.js";

export const TICK_MS = 2_000;
export const HEALTH_INTERVAL_MS = 15_000;
export const RESYNC_MS = 30_000;
export const WAKE_GAP_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export type Result = [Model, Effect[]];

export const initialModel = (): Model => ({
  now: 0,
  runners: {},
  agents: {},
  tasks: {},
  chats: {},
  guideSessions: {},
  guideCatalog: [],
  notifications: [],
  local: null,
});

export const agentKey = (runner: string, id: string): string => `${runner}/${id}`;

/** "07:30" → 450; null for anything that isn't a valid HH:MM. */
export const minuteOfDay = (at: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const TERMINAL: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled", "rejected", "lost"]);

export const isTerminal = (task: Task): boolean => TERMINAL.has(task.state);

export const backoffMs = (failures: number): number =>
  Math.min(1000 * 2 ** Math.max(failures - 1, 0), MAX_BACKOFF_MS);

/** Agents are reached only through their runner's live link, never via the URL in an agent card. */
const endpoint = (r: Runner, agentId: string): Endpoint | null =>
  r.link.state === "up" ? { url: `${r.link.url}/agents/${agentId}`, token: r.token } : null;

const setTask = (model: Model, task: Task): Model => ({
  ...model,
  tasks: { ...model.tasks, [task.id]: { ...task, updatedAt: model.now } },
});

const setAgent = (model: Model, agent: Agent): Model => ({
  ...model,
  agents: { ...model.agents, [agent.key]: agent },
});

const isSyncable = (task: Task): task is Task & { remoteId: string } =>
  !isTerminal(task) && task.remoteId !== null;

const getTaskEffect = (model: Model, task: Task & { remoteId: string }): Effect[] => {
  const runner = model.runners[task.runner];
  const ep = runner ? endpoint(runner, task.agent) : null;
  return ep ? [{ type: "GetTask", taskId: task.id, endpoint: ep, remoteId: task.remoteId }] : [];
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
 * Used on boot and on wake. Every link reopens (tunnels often hang silently after sleep) and
 * runners drop to `unknown`, closing every stream; `LinkUp` → health check → `RunnerOk` re-fetches tasks.
 */
const resyncAll = (model: Model): Model => {
  const runners = Object.fromEntries(
    Object.values(model.runners).map((r): [string, Runner] => [
      r.name,
      {
        ...r,
        status: "unknown",
        link: { state: "down", error: null },
        linkEpoch: r.linkEpoch + 1,
        linkFailures: 0,
        linkRetryAt: 0,
        // A change in flight when the Controller stopped never reports back; the next index tells.
        agentsChange: r.agentsChange?.state === "adding" ? null : (r.agentsChange ?? null),
      },
    ]),
  );
  const tasks = Object.fromEntries(
    Object.values(model.tasks).map((t) => [
      t.id,
      isSyncable(t) ? { ...t, streamEpoch: t.streamEpoch + 1, streamFailures: 0, streamRetryAt: 0 } : t,
    ]),
  );
  return { ...model, runners, tasks };
};

const markLostDispatches = (model: Model): Model =>
  Object.values(model.tasks)
    .filter((t) => t.state === "dispatching")
    .reduce(
      (m, t) => setTask(m, { ...t, state: "lost", statusText: "controller restarted during dispatch" }),
      model,
    );

const checkRunner = (r: Runner): Effect[] => (r.link.state === "up" ? [{ type: "CheckRunner", runner: r.name, url: r.link.url }] : []);

const dueRunnerChecks = (model: Model): Result => {
  const due = Object.values(model.runners).filter((r) => r.link.state === "up" && r.nextCheckAt <= model.now);
  const next = due.reduce((m, r) => setRunner(m, { ...r, nextCheckAt: m.now + HEALTH_INTERVAL_MS }), model);
  return [next, due.flatMap(checkRunner)];
};

const dueResyncs = (model: Model): Result => {
  const due = Object.values(model.tasks)
    .filter(isSyncable)
    .filter((t) => model.now - t.lastSyncAt >= RESYNC_MS && model.runners[t.runner]?.status === "healthy");
  const next = due.reduce((m, t) => setTask(m, { ...t, lastSyncAt: m.now }), model);
  return [next, due.flatMap((t) => getTaskEffect(model, t))];
};

const createTask = (model: Model, taskId: string, key: string, prompt: string, trigger: Task["trigger"]): Result => {
  const agent = model.agents[key];
  const runner = agent ? model.runners[agent.runner] : undefined;
  if (!agent || !runner) return [notify(model, "error", `unknown agent ${key}`), []];
  if (model.tasks[taskId]) return [model, []];
  const ep = runner.status === "healthy" ? endpoint(runner, agent.id) : null;
  const task: Task = {
    id: taskId,
    runner: agent.runner,
    agent: agent.id,
    prompt,
    remoteId: null,
    state: ep ? "dispatching" : "queued",
    statusText: ep ? null : `waiting for runner ${runner.name}`,
    artifacts: [],
    createdAt: model.now,
    updatedAt: model.now,
    trigger,
    ackedAt: null,
    lastSyncAt: model.now,
    streamEpoch: 0,
    streamFailures: 0,
    streamRetryAt: 0,
  };
  return [setTask(model, task), ep ? [{ type: "Dispatch", taskId, endpoint: ep, prompt }] : []];
};

/** Runs created while the runner was away go out once it answers again. */
const dispatchQueued = (model: Model, runner: Runner): Result =>
  Object.values(model.tasks)
    .filter((t) => t.runner === runner.name && t.state === "queued")
    .reduce<Result>(
      ([m, effects], t) => {
        const ep = endpoint(runner, t.agent);
        if (!ep) return [m, effects];
        return [setTask(m, { ...t, state: "dispatching", statusText: null }), [...effects, { type: "Dispatch", taskId: t.id, endpoint: ep, prompt: t.prompt }]];
      },
      [model, []],
    );

/** One run per agent per local day, on the first tick at or after its time (so a sleeping laptop catches up on wake). */
const dueSchedules = (model: Model): Result => {
  const local = model.local;
  if (!local) return [model, []];
  const due = Object.values(model.agents).filter((a) => {
    const at = a.schedule ? minuteOfDay(a.schedule.at) : null;
    return at !== null && local.minute >= at && a.lastScheduledDay !== local.day;
  });
  return due.reduce<Result>(
    ([m, effects], a) => {
      const marked = setAgent(m, { ...a, lastScheduledDay: local.day });
      const [next, more] = createTask(marked, `schedule:${a.key}:${local.day}`, a.key, a.schedule?.prompt ?? "", "schedule");
      return [next, [...effects, ...more]];
    },
    [model, []],
  );
};

const tick = (model: Model, now: number, local: LocalClock | undefined): Result => {
  const woke = model.now !== 0 && now - model.now > WAKE_GAP_MS;
  const ticked = { ...model, now, local: local ?? model.local };
  const afterWake = woke ? resyncAll(notify(ticked, "info", "wake detected, resyncing")) : ticked;
  const [afterChecks, checkEffects] = dueRunnerChecks(afterWake);
  const [afterResync, resyncEffects] = dueResyncs(afterChecks);
  const [afterSchedules, scheduleEffects] = dueSchedules(afterResync);
  return [afterSchedules, [...checkEffects, ...resyncEffects, ...scheduleEffects]];
};

const setSchedule = (model: Model, key: string, at: string | null, prompt: string): Result => {
  const agent = model.agents[key];
  if (!agent) return [notify(model, "error", `unknown agent ${key}`), []];
  if (at === null) return [setAgent(model, { ...agent, schedule: null }), []];
  const minute = minuteOfDay(at);
  if (minute === null) return [notify(model, "error", `invalid schedule time ${at}; use HH:MM`), []];
  // Setting 07:30 at 15:00 shouldn't fire right away; today's slot counts as already done.
  const passedToday = model.local !== null && model.local.minute >= minute;
  return [
    notify(
      setAgent(model, { ...agent, schedule: { at, prompt }, lastScheduledDay: passedToday ? model.local!.day : agent.lastScheduledDay }),
      "info",
      `${agent.name} runs daily at ${at}`,
    ),
    [],
  ];
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

/** Keeps schedules of agents the runner still serves; agents it dropped disappear. */
const syncAgents = (model: Model, runner: string, infos: AgentInfo[]): Model => {
  const others = Object.fromEntries(Object.entries(model.agents).filter(([, a]) => a.runner !== runner));
  const mine = Object.fromEntries(
    infos.map((info): [string, Agent] => {
      const key = agentKey(runner, info.id);
      const prev = model.agents[key];
      return [key, { ...info, key, runner, schedule: prev?.schedule ?? null, lastScheduledDay: prev?.lastScheduledDay ?? null }];
    }),
  );
  return { ...model, agents: { ...others, ...mine } };
};

type RunnerIndex = { agents: AgentInfo[]; location: string | null; available: AgentInfo[] | null; canCreate?: boolean };

const runnerOk = (model: Model, name: string, { agents, location, available, canCreate }: RunnerIndex): Result => {
  const runner = model.runners[name];
  if (!runner) return [model, []];
  const recovered = runner.status !== "healthy";
  const updated = syncAgents(
    setRunner(model, {
      ...runner,
      status: "healthy",
      failures: 0,
      lastError: null,
      lastSeenAt: model.now,
      nextCheckAt: model.now + HEALTH_INTERVAL_MS,
      location,
      available: available ?? null,
      canCreateAgents: canCreate === true,
    }),
    name,
    agents,
  );
  const catchUp = recovered
    ? Object.values(model.tasks)
        .filter(isSyncable)
        .filter((t) => t.runner === name)
        .flatMap((t) => getTaskEffect(updated, t))
    : [];
  const [dispatched, dispatches] = dispatchQueued(updated, updated.runners[name]!);
  return [recovered ? notify(dispatched, "info", `runner ${name} healthy`) : dispatched, [...catchUp, ...dispatches]];
};

const linkUp = (model: Model, name: string, epoch: number, url: string): Result => {
  const runner = model.runners[name];
  if (!runner || runner.linkEpoch !== epoch) return [model, []];
  const up: Runner = { ...runner, link: { state: "up", url }, linkFailures: 0, nextCheckAt: model.now + HEALTH_INTERVAL_MS };
  return [setRunner(model, up), checkRunner(up)];
};

/** Like a task stream: bump the epoch, back off, and let the subscription reopen it. */
const linkDown = (model: Model, name: string, epoch: number, error: string | null): Model => {
  const runner = model.runners[name];
  if (!runner || runner.linkEpoch !== epoch) return model;
  const failures = runner.linkFailures + 1;
  const reason = error ?? "connection closed";
  const updated = setRunner(model, {
    ...runner,
    link: { state: "down", error: reason },
    linkEpoch: epoch + 1,
    linkFailures: failures,
    linkRetryAt: model.now + backoffMs(failures),
    status: "unreachable",
    lastError: reason,
  });
  return runner.status === "unreachable" ? updated : notify(updated, "error", `runner ${name} disconnected: ${reason}`);
};

/** New config takes effect through a fresh link; vault entries only the old config used are deleted. */
const updateRunner = (model: Model, name: string, transport: TransportSpec | null, token: SecretRef | null): Result => {
  const runner = model.runners[name];
  if (!runner) return [notify(model, "error", `unknown runner ${name}`), []];
  const next: Runner = {
    ...runner,
    transport: transport ?? runner.transport,
    token: token ?? runner.token,
    status: "unknown",
    link: { state: "down", error: null },
    linkEpoch: runner.linkEpoch + 1,
    linkFailures: 0,
    linkRetryAt: 0,
  };
  const kept = new Set(vaultKeys(next));
  const stale = vaultKeys(runner).filter((k) => !kept.has(k));
  return [notify(setRunner(model, next), "info", `runner ${name} updated`), stale.length > 0 ? [{ type: "DeleteSecrets", keys: stale }] : []];
};

/** Runs `change` against a reachable runner with no other agent change in flight; a refusal stays on the runner. */
const changeAgents = (model: Model, name: string, agents: string[], change: (runner: Runner, url: string, fail: (error: string) => Result) => Result): Result => {
  const runner = model.runners[name];
  if (!runner) return [notify(model, "error", `unknown runner ${name}`), []];
  const fail = (error: string): Result => [setRunner(model, { ...runner, agentsChange: { state: "failed", agents, error } }), []];
  if (runner.agentsChange?.state === "adding") return [model, []];
  if (runner.status !== "healthy" || runner.link.state !== "up") return fail(`${name} isn't reachable right now`);
  return change(runner, runner.link.url, fail);
};

const changing = (model: Model, runner: Runner, agents: string[], effect: Effect): Result => [
  setRunner(model, { ...runner, agentsChange: { state: "adding", agents } }),
  [effect],
];

/** Asks the runner to serve what it serves now plus `ids`; the runner answers with its new index. */
const addAgents = (model: Model, name: string, ids: string[]): Result =>
  changeAgents(model, name, ids, (runner, url, fail) => {
    if (!runner.available) return fail(`${name} can't change its agents; update the runner`);
    const unknown = ids.find((id) => !runner.available!.some((a) => a.id === id));
    if (unknown) return fail(`${name} has no agent ${unknown} to add`);
    const served = Object.values(model.agents).filter((a) => a.runner === name).map((a) => a.id);
    const agents = [...new Set([...served, ...ids])].sort();
    return changing(model, runner, ids, { type: "SetRunnerAgents", runner: name, endpoint: { url, token: runner.token }, agents, added: ids });
  });

/** The change shows the new agent's name until the runner answers with its id. */
const createAgent = (model: Model, name: string, agent: NewAgentSpec): Result =>
  changeAgents(model, name, [agent.name], (runner, url, fail) =>
    runner.canCreateAgents
      ? changing(model, runner, [agent.name], { type: "CreateRunnerAgent", runner: name, endpoint: { url, token: runner.token }, agent })
      : fail(`${name} can't create agents; update the runner`),
  );

const agentsSet = (model: Model, msg: Extract<Msg, { type: "AgentsSet" }>): Result => {
  const runner = model.runners[msg.runner];
  if (!runner) return [model, []];
  const [next, effects] = runnerOk(setRunner(model, { ...runner, agentsChange: null }), msg.runner, msg);
  const names = msg.agents.filter((a) => msg.added.includes(a.id)).map((a) => a.name);
  return [notify(next, "info", `added ${names.join(", ")} to ${msg.runner}`), effects];
};

const agentsSetFailed = (model: Model, name: string, error: string): Model => {
  const runner = model.runners[name];
  if (!runner) return model;
  const agents = runner.agentsChange?.agents ?? [];
  return notify(setRunner(model, { ...runner, agentsChange: { state: "failed", agents, error } }), "error", `couldn't add agents to ${name}: ${error}`);
};

/** EC2 runners can always be uninstalled, including ones the guide adopted before that was offered. */
export const canTearDown = (runner: NewRunner): boolean => runner.transport.kind === "aws_ssm" || runner.origin?.teardown != null;

const removeRunner = (model: Model, name: string, teardown: boolean): Result => {
  const runner = model.runners[name];
  if (!runner) return [model, []];
  const { [name]: _removed, ...runners } = model.runners;
  const agents = Object.fromEntries(Object.entries(model.agents).filter(([, a]) => a.runner !== name));
  const orphaned = Object.values(model.tasks).filter((t) => t.runner === name && !isTerminal(t));
  const lost = orphaned.reduce((m, t) => setTask(m, { ...t, state: "lost", statusText: `runner ${name} was removed` }), { ...model, runners, agents });
  return [lost, [{ type: "RetireRunner", runner: runnerSpec(runner), teardown: teardown && canTearDown(runner) }]];
};

const withTask = (model: Model, taskId: string, f: (task: Task) => Result): Result => {
  const task = model.tasks[taskId];
  return task ? f(task) : [model, []];
};

export const update = (model: Model, msg: Msg): Result => {
  switch (msg.type) {
    case "AddRunner": {
      if (model.runners[msg.name]) return [notify(model, "error", `runner ${msg.name} already exists`), []];
      const { type: _type, ...spec } = msg;
      return [addRunner(model, spec), []];
    }

    case "UpdateRunner":
      return updateRunner(model, msg.name, msg.transport, msg.token);

    case "RemoveRunner":
      return removeRunner(model, msg.name, msg.teardown);

    case "RunnerRetired":
      return [notify(model, msg.ok ? "info" : "error", msg.text), []];

    case "LinkUp":
      return linkUp(model, msg.runner, msg.epoch, msg.url);

    case "LinkDown":
      return [linkDown(model, msg.runner, msg.epoch, msg.error), []];

    case "CreateTask":
      return createTask(model, msg.taskId, msg.agent, msg.prompt, "manual");

    case "CancelTask":
      return withTask(model, msg.taskId, (task) => {
        if (task.state === "queued") return [setTask(model, { ...task, state: "canceled", statusText: "canceled before it was sent" }), []];
        const runner = model.runners[task.runner];
        const ep = runner ? endpoint(runner, task.agent) : null;
        if (!isSyncable(task) || !ep) return [notify(model, "error", `task ${task.id} cannot be canceled`), []];
        return [model, [{ type: "Cancel", taskId: task.id, endpoint: ep, remoteId: task.remoteId }]];
      });

    case "Booted":
      return [resyncAll(interruptGuides(failInterruptedChats(markLostDispatches({ ...model, now: msg.now, guideCatalog: msg.guides })))), []];

    case "Tick":
      return tick(model, msg.now, msg.local);

    case "RunnerOk":
      return runnerOk(model, msg.name, msg);

    case "AddAgents":
      return addAgents(model, msg.runner, msg.agents);

    case "CreateAgent":
      return createAgent(model, msg.runner, msg.agent);

    case "AgentsSet":
      return agentsSet(model, msg);

    case "AgentsSetFailed":
      return [agentsSetFailed(model, msg.runner, msg.error), []];

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

    case "AckInbox":
      return withTask(model, msg.taskId, (task) =>
        isTerminal(task) && !task.ackedAt ? [setTask(model, { ...task, ackedAt: model.now }), []] : [model, []],
      );

    case "AckAllInbox":
      return [inboxOf(model).reduce((m, t) => setTask(m, { ...t, ackedAt: m.now }), model), []];

    case "CreateChat":
      if (model.chats[msg.chatId]) return [model, []];
      return createChat(model, msg.chatId, msg.fromTaskId, msg.text);

    case "SendChatMessage":
      return sendChatMessage(model, msg.chatId, msg.text);

    case "ChatReplied":
      return [chatReplied(model, msg.chatId, msg.text), []];

    case "ChatFailed":
      return [chatFailed(model, msg.chatId, msg.error), []];

    case "SetSchedule":
      return setSchedule(model, msg.agent, msg.at, msg.prompt);

    case "StartGuide":
      return startGuide(model, msg.sessionId, msg.guide);

    case "GuideInput":
      return guideInput(model, msg.sessionId, msg.input);

    case "GuideRetry":
      return guideRetry(model, msg.sessionId);

    case "CancelGuide":
      return cancelGuide(model, msg.sessionId);

    case "GuideStepped":
      return guideStepped(model, msg.sessionId, msg.result);
  }
};

/** Finished runs nobody has dealt with yet, newest first. */
export const inboxOf = (model: Model): Task[] =>
  Object.values(model.tasks)
    .filter((t) => isTerminal(t) && !t.ackedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);

const taskStreams = (model: Model): Sub[] =>
  Object.values(model.tasks)
    .filter(isSyncable)
    .filter((t) => model.now >= t.streamRetryAt)
    .flatMap((t): Sub[] => {
      const runner = model.runners[t.runner];
      const ep = runner?.status === "healthy" ? endpoint(runner, t.agent) : null;
      return ep ? [{ type: "TaskStream", key: `${t.id}#${t.streamEpoch}`, taskId: t.id, epoch: t.streamEpoch, endpoint: ep, remoteId: t.remoteId }] : [];
    });

/** Every runner wants its link open; reconnects after restart, wake or a drop come from here. */
const links = (model: Model): Sub[] =>
  Object.values(model.runners)
    .filter((r) => model.now >= r.linkRetryAt)
    .map((r): Sub => ({ type: "Link", key: `link:${r.name}#${r.linkEpoch}`, runner: r.name, epoch: r.linkEpoch, transport: r.transport }));

export const subscriptions = (model: Model): Sub[] => [...links(model), ...taskStreams(model)];
