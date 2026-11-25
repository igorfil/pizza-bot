import { chatFailed, chatReplied, createChat, failInterruptedChats, sendChatMessage } from "./chat.js";
import { cancelGuide, guideInput, guideRetry, guideStepped, interruptGuides, startGuide } from "./guide-session.js";
import { addRunner, notify, runnerSpec, setRunner, vaultKeys } from "./runners.js";
import type {
  Agent,
  AgentInfo,
  AgentsChange,
  Effect,
  Endpoint,
  LocalClock,
  Model,
  Msg,
  NewAgentSpec,
  NewRunner,
  Runner,
  RunnerIndexFields,
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
  contextId: snapshot.contextId || task.contextId,
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
        agentsChange: r.agentsChange?.error ? r.agentsChange : null,
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

type Conversation = { contextId: string | null; followUpOf: string | null };

const NEW_CONVERSATION: Conversation = { contextId: null, followUpOf: null };

/** A follow-up goes to the earlier run's agent in its context, once nothing else in that context is running. */
const followUp = (model: Model, taskId: string, fromId: string, prompt: string): Result => {
  const from = model.tasks[fromId];
  if (!from) return [notify(model, "error", `unknown run ${fromId}`), []];
  if (!isTerminal(from) || !from.contextId) return [notify(model, "error", "a follow-up has to wait until the run has finished"), []];
  const busy = Object.values(model.tasks).some((t) => t.contextId === from.contextId && t.runner === from.runner && !isTerminal(t));
  if (busy) return [notify(model, "error", "this conversation already has a run in progress"), []];
  return createTask(model, taskId, agentKey(from.runner, from.agent), prompt, "manual", { contextId: from.contextId, followUpOf: from.id });
};

const createTask = (model: Model, taskId: string, key: string, prompt: string, trigger: Task["trigger"], conversation = NEW_CONVERSATION): Result => {
  const agent = model.agents[key];
  const runner = agent ? model.runners[agent.runner] : undefined;
  if (!agent || !runner) return [notify(model, "error", `unknown agent ${key}`), []];
  if (model.tasks[taskId]) return [model, []];
  if (agent.enabled === false) return [notify(model, "error", `${agent.name} is disabled; enable it to run it`), []];
  const ep = runner.status === "healthy" ? endpoint(runner, agent.id) : null;
  const task: Task = {
    id: taskId,
    runner: agent.runner,
    agent: agent.id,
    prompt,
    remoteId: null,
    ...conversation,
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
  return [setTask(model, task), ep ? [{ type: "Dispatch", taskId, endpoint: ep, prompt, contextId: task.contextId }] : []];
};

/** Runs created while the runner was away go out once it answers again. */
const dispatchQueued = (model: Model, runner: Runner): Result =>
  Object.values(model.tasks)
    .filter((t) => t.runner === runner.name && t.state === "queued")
    .reduce<Result>(
      ([m, effects], t) => {
        const ep = endpoint(runner, t.agent);
        if (!ep) return [m, effects];
        return [setTask(m, { ...t, state: "dispatching", statusText: null }), [...effects, { type: "Dispatch", taskId: t.id, endpoint: ep, prompt: t.prompt, contextId: t.contextId }]];
      },
      [model, []],
    );

/** One run per agent per local day, on the first tick at or after its time (so a sleeping laptop catches up on wake). */
const dueSchedules = (model: Model): Result => {
  const local = model.local;
  if (!local) return [model, []];
  const due = Object.values(model.agents).filter((a) => {
    if (a.enabled === false) return false;
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

const tick = (model: Model, now: number, local: LocalClock | undefined, since: number | undefined): Result => {
  const prev = since ?? model.now;
  const woke = prev !== 0 && now - prev > WAKE_GAP_MS;
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

/** Every agent the runner reports, served (enabled) or not; schedules stay across both. Agents it no longer has disappear. */
const syncAgents = (model: Model, runner: string, served: AgentInfo[], available: AgentInfo[]): Model => {
  const others = Object.fromEntries(Object.entries(model.agents).filter(([, a]) => a.runner !== runner));
  const entry = (info: AgentInfo, enabled: boolean): [string, Agent] => {
    const key = agentKey(runner, info.id);
    const prev = model.agents[key];
    return [key, { ...info, key, runner, enabled, schedule: prev?.schedule ?? null, lastScheduledDay: prev?.lastScheduledDay ?? null }];
  };
  const mine = Object.fromEntries([...available.map((info) => entry(info, false)), ...served.map((info) => entry(info, true))]);
  return { ...model, agents: { ...others, ...mine } };
};

const runnerOk = (model: Model, name: string, { agents, location, available, canCreate, harnesses, plugins, mcpServers }: RunnerIndexFields): Result => {
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
      harnesses: harnesses ?? [],
      plugins: plugins ?? [],
      mcpServers: mcpServers ?? {},
    }),
    name,
    agents,
    available ?? [],
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

type ChangeContext = { runner: Runner; url: string; fail: (error: string) => Result; start: (effect: Effect) => Result };

/** Runs `change` against a reachable runner with no other agent change in flight; a refusal stays on the runner. */
const changeAgents = (model: Model, name: string, action: AgentsChange["action"], agents: string[], change: (c: ChangeContext) => Result): Result => {
  const runner = model.runners[name];
  if (!runner) return [notify(model, "error", `unknown runner ${name}`), []];
  const fail = (error: string): Result => [setRunner(model, { ...runner, agentsChange: { action, agents, error } }), []];
  const start = (effect: Effect): Result => [setRunner(model, { ...runner, agentsChange: { action, agents, error: null } }), [effect]];
  if (runner.agentsChange && runner.agentsChange.error === null) return [model, []];
  if (runner.status !== "healthy" || runner.link.state !== "up") return fail(`${name} isn't reachable right now`);
  return change({ runner, url: runner.link.url, fail, start });
};

const servedIds = (model: Model, runner: string): string[] =>
  Object.values(model.agents)
    .filter((a) => a.runner === runner && a.enabled !== false)
    .map((a) => a.id);

const hasRunInProgress = (model: Model, agent: Agent): boolean =>
  Object.values(model.tasks).some((t) => t.runner === agent.runner && t.agent === agent.id && !isTerminal(t) && t.state !== "queued");

/** Asks the runner to serve what it serves now plus `ids`; the runner answers with its new index. */
const addAgents = (model: Model, name: string, ids: string[]): Result =>
  changeAgents(model, name, "add", ids, ({ runner, url, fail, start }) => {
    if (!runner.available) return fail(`${name} can't change its agents; update the runner`);
    const unknown = ids.find((id) => !runner.available!.some((a) => a.id === id));
    if (unknown) return fail(`${name} has no agent ${unknown} to add`);
    const agents = [...new Set([...servedIds(model, name), ...ids])].sort();
    return start({ type: "SetRunnerAgents", runner: name, endpoint: { url, token: runner.token }, agents, added: ids });
  });

/** The runner serves the agent again; it keeps its schedule and runs. */
const enableAgent = (model: Model, key: string): Result => {
  const agent = model.agents[key];
  if (!agent) return [notify(model, "error", `unknown agent ${key}`), []];
  if (agent.enabled !== false) return [model, []];
  return changeAgents(model, agent.runner, "enable", [agent.name], ({ runner, url, start }) =>
    start({ type: "SetRunnerAgents", runner: runner.name, endpoint: { url, token: runner.token }, agents: [...servedIds(model, agent.runner), agent.id].sort(), added: [agent.id] }),
  );
};

/** The runner stops serving the agent but keeps it, so it can be enabled again; waits for a run in progress. */
const disableAgent = (model: Model, key: string): Result => {
  const agent = model.agents[key];
  if (!agent) return [notify(model, "error", `unknown agent ${key}`), []];
  if (agent.enabled === false) return [model, []];
  return changeAgents(model, agent.runner, "disable", [agent.name], ({ runner, url, fail, start }) =>
    hasRunInProgress(model, agent)
      ? fail(`${agent.name} has a run in progress; cancel it or wait for it to finish`)
      : start({
          type: "SetRunnerAgents",
          runner: runner.name,
          endpoint: { url, token: runner.token },
          agents: servedIds(model, agent.runner).filter((id) => id !== agent.id),
          added: [],
          disabled: [agent.id],
        }),
  );
};

/** The change shows the new agent's name until the runner answers with its id. */
const createAgent = (model: Model, name: string, agent: NewAgentSpec): Result =>
  changeAgents(model, name, "add", [agent.name], ({ runner, url, fail, start }) =>
    runner.canCreateAgents
      ? start({ type: "CreateRunnerAgent", runner: name, endpoint: { url, token: runner.token }, agent })
      : fail(`${name} can't create agents; update the runner`),
  );

/** Deleting would orphan a run in progress, so it waits until the agent is idle. */
const deleteAgent = (model: Model, key: string): Result => {
  const agent = model.agents[key];
  if (!agent) return [notify(model, "error", `unknown agent ${key}`), []];
  return changeAgents(model, agent.runner, "remove", [agent.name], ({ runner, url, fail, start }) =>
    hasRunInProgress(model, agent)
      ? fail(`${agent.name} has a run in progress; cancel it or wait for it to finish`)
      : start({ type: "DeleteRunnerAgent", runner: runner.name, endpoint: { url, token: runner.token }, agentId: agent.id }),
  );
};

/** Same id, new name, model or prompt; runs already going finish with the old ones. */
const editAgent = (model: Model, key: string, spec: NewAgentSpec): Result => {
  const agent = model.agents[key];
  if (!agent) return [notify(model, "error", `unknown agent ${key}`), []];
  return changeAgents(model, agent.runner, "edit", [agent.name], ({ runner, url, fail, start }) =>
    agent.created
      ? start({ type: "EditRunnerAgent", runner: runner.name, endpoint: { url, token: runner.token }, agentId: agent.id, agent: spec })
      : fail(`${agent.name} ships with ${runner.name}; only agents created here can be edited`),
  );
};

/** MCP servers are changed on a reachable runner; it answers with its new index. */
const changeMcpServer = (model: Model, name: string, effect: (endpoint: Endpoint) => Effect): Result => {
  const runner = model.runners[name];
  if (!runner) return [notify(model, "error", `unknown runner ${name}`), []];
  if (runner.status !== "healthy" || runner.link.state !== "up") return [notify(model, "error", `${name} isn't reachable right now`), []];
  return [model, [effect({ url: runner.link.url, token: runner.token })]];
};

const agentsSet = (model: Model, msg: Extract<Msg, { type: "AgentsSet" }>): Result => {
  const runner = model.runners[msg.runner];
  if (!runner) return [model, []];
  const removed = msg.removed ?? [];
  const disabled = msg.disabled ?? [];
  const nameOf = (id: string) => model.agents[agentKey(msg.runner, id)]?.name ?? id;
  const why = (id: string) => (removed.includes(id) ? "the agent was deleted" : disabled.includes(id) ? "the agent was disabled" : null);
  // Runs still waiting for the runner would otherwise be sent to an agent that's gone, so cancel them before syncing.
  const canceled = Object.values(model.tasks)
    .filter((t) => t.runner === msg.runner && why(t.agent) !== null && t.state === "queued")
    .reduce((m, t) => setTask(m, { ...t, state: "canceled", statusText: why(t.agent) }), setRunner(model, { ...runner, agentsChange: null }));
  const [next, effects] = runnerOk(canceled, msg.runner, msg);
  const namesOf = (ids: string[]) => msg.agents.filter((a) => ids.includes(a.id)).map((a) => a.name).join(", ");
  const known = msg.added.length > 0 && msg.added.every((id) => model.agents[agentKey(msg.runner, id)] !== undefined);
  const text =
    removed.length > 0
      ? `removed ${removed.map(nameOf).join(", ")} from ${msg.runner}`
      : disabled.length > 0
        ? `disabled ${disabled.map(nameOf).join(", ")} on ${msg.runner}`
        : msg.edited?.length
          ? `updated ${namesOf(msg.edited)} on ${msg.runner}`
          : known
            ? `enabled ${namesOf(msg.added)} on ${msg.runner}`
            : `added ${namesOf(msg.added)} to ${msg.runner}`;
  return [notify(next, "info", text), effects];
};

const agentsSetFailed = (model: Model, name: string, error: string): Model => {
  const runner = model.runners[name];
  if (!runner) return model;
  const action = runner.agentsChange?.action ?? "add";
  const agents = runner.agentsChange?.agents ?? [];
  return notify(setRunner(model, { ...runner, agentsChange: { action, agents, error } }), "error", `couldn't ${action} agents on ${name}: ${error}`);
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

/** A Tick that only moved the clock; it can stay out of the log if the latest one is logged before the next Msg. */
export const isQuietTick = (before: Model, [after, effects]: Result): boolean =>
  effects.length === 0 && (Object.keys(after) as (keyof Model)[]).every((k) => k === "now" || k === "local" || after[k] === before[k]);

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

    case "RenameRunner": {
      const runner = model.runners[msg.name];
      if (!runner) return [notify(model, "error", `unknown runner ${msg.name}`), []];
      return [setRunner(model, { ...runner, label: msg.label }), []];
    }

    case "RunnerRetired":
      return [notify(model, msg.ok ? "info" : "error", msg.text), []];

    case "LinkUp":
      return linkUp(model, msg.runner, msg.epoch, msg.url);

    case "LinkDown":
      return [linkDown(model, msg.runner, msg.epoch, msg.error), []];

    case "CreateTask":
      return msg.followUpOf ? followUp(model, msg.taskId, msg.followUpOf, msg.prompt) : createTask(model, msg.taskId, msg.agent, msg.prompt, "manual");

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
      return tick(model, msg.now, msg.local, msg.since);

    case "RunnerOk":
      return runnerOk(model, msg.name, msg);

    case "AddAgents":
      return addAgents(model, msg.runner, msg.agents);

    case "EnableAgent":
      return enableAgent(model, msg.agent);

    case "DisableAgent":
      return disableAgent(model, msg.agent);

    case "CreateAgent":
      return createAgent(model, msg.runner, msg.agent);

    case "DeleteAgent":
      return deleteAgent(model, msg.agent);

    case "EditAgent":
      return editAgent(model, msg.agent, msg.spec);

    case "AgentsSet":
      return agentsSet(model, msg);

    case "SetMcpServer":
      return changeMcpServer(model, msg.runner, (endpoint) => ({ type: "PutRunnerMcpServer", runner: msg.runner, endpoint, id: msg.id, entry: msg.entry }));

    case "RemoveMcpServer":
      return changeMcpServer(model, msg.runner, (endpoint) => ({ type: "DeleteRunnerMcpServer", runner: msg.runner, endpoint, id: msg.id }));

    case "McpServersSet": {
      const [next, effects] = runnerOk(model, msg.runner, msg);
      return [notify(next, "info", msg.text), effects];
    }

    case "McpServerFailed":
      return [notify(model, "error", msg.text), []];

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
      return guideStepped(model, msg.sessionId, msg.attempt ?? 0, msg.result);
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
