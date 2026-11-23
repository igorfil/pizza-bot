import { describe, expect, test } from "vitest";
import type { AgentInfo, GuideResult, Model, Msg, Sub, TaskSnapshot } from "./types.js";
import { inboxOf, initialModel, subscriptions, update, WAKE_GAP_MS } from "./update.js";

const run = (msgs: Msg[], start: Model = initialModel()) =>
  msgs.reduce<[Model, ReturnType<typeof update>[1]]>(([m], msg) => update(m, msg), [start, []]);

const working: TaskSnapshot = { remoteId: "r1", state: "working", statusText: "step 1/3", artifacts: [] };

const sys = { id: "sys", name: "System report", description: "", input: null };
const healthy = (agents = [sys], available: AgentInfo[] | null = null): Msg => ({ type: "RunnerOk", name: "local", agents, location: "laptop", available });
const token = { kind: "vault", key: "runner/local/k" } as const;
const ep = { url: "http://x/agents/sys", token };
const addLocal: Msg = { type: "AddRunner", name: "local", transport: { kind: "direct", url: "http://x" }, token, origin: null };
const linkUp = (epoch = 0, url = "http://x"): Msg => ({ type: "LinkUp", runner: "local", epoch, url });
const booted: Msg = { type: "Booted", now: 50_000, guides: [] };
const streams = (model: Model): Sub[] => subscriptions(model).filter((s) => s.type === "TaskStream");
const linkKeys = (model: Model): string[] => subscriptions(model).filter((s) => s.type === "Link").map((s) => s.key);

const withRunningTask: Msg[] = [
  { type: "Tick", now: 1_000 },
  addLocal,
  linkUp(),
  healthy(),
  { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "steps=3 hi" },
  { type: "Dispatched", taskId: "t1", snapshot: working },
];

describe("update", () => {
  test("CreateTask emits a Dispatch effect for the runner", () => {
    const [, effects] = run(withRunningTask.slice(0, 5));
    expect(effects).toEqual([
      { type: "Dispatch", taskId: "t1", endpoint: ep, prompt: "steps=3 hi" },
    ]);
  });

  test("CreateTask for an unknown agent adds an error notification", () => {
    const [model] = run([{ type: "CreateTask", taskId: "t1", agent: "nope/x", prompt: "x" }]);
    expect(model.notifications.at(-1)?.text).toBe("unknown agent nope/x");
  });

  test("RunnerOk registers the runner's agents under runner/id keys", () => {
    const [model] = run(withRunningTask.slice(0, 4));
    expect(Object.keys(model.agents)).toEqual(["local/sys"]);
  });

  test("an agent the runner stops serving disappears", () => {
    const [model] = run([...withRunningTask.slice(0, 4), healthy([])]);
    expect(model.agents).toEqual({});
  });

  test("RemoveRunner removes its agents", () => {
    const [model] = run([...withRunningTask.slice(0, 4), { type: "RemoveRunner", name: "local", teardown: false }]);
    expect(model.agents).toEqual({});
  });

  test("a running task on a healthy runner has one stream subscription", () => {
    const [model] = run(withRunningTask);
    expect(streams(model).map((s) => s.key)).toEqual(["t1#0"]);
  });

  test("StreamDropped bumps the epoch, backs off, and re-fetches the task", () => {
    const [model, effects] = run([...withRunningTask, { type: "StreamDropped", taskId: "t1", epoch: 0, error: "reset" }]);
    expect([model.tasks.t1?.streamEpoch, streams(model), effects.map((e) => e.type)]).toEqual([1, [], ["GetTask"]]);
  });

  test("a stale StreamDropped from an old epoch is ignored", () => {
    const [before] = run([...withRunningTask, { type: "StreamDropped", taskId: "t1", epoch: 0, error: null }]);
    const [after, effects] = update(before, { type: "StreamDropped", taskId: "t1", epoch: 0, error: null });
    expect([after.tasks.t1?.streamEpoch, effects]).toEqual([1, []]);
  });

  test("a Tick after a long gap reopens every link", () => {
    const [model] = run([...withRunningTask, { type: "Tick", now: 1_000 + WAKE_GAP_MS + 1 }]);
    expect(linkKeys(model)).toEqual(["link:local#1"]);
  });

  test("after wake there are no streams until the runner answers", () => {
    const [model] = run([...withRunningTask, { type: "Tick", now: 1_000 + WAKE_GAP_MS + 1 }]);
    expect(streams(model)).toEqual([]);
  });

  test("RunnerOk after a restart re-fetches that runner's open tasks", () => {
    const [, effects] = run([...withRunningTask, booted, linkUp(1), healthy()]);
    expect(effects).toEqual([{ type: "GetTask", taskId: "t1", endpoint: ep, remoteId: "r1" }]);
  });

  test("Booted marks in-flight dispatches as lost", () => {
    const [model] = run([...withRunningTask.slice(0, 5), booted]);
    expect(model.tasks.t1?.state).toBe("lost");
  });

  test("a snapshot overrides state and artifacts", () => {
    const done: TaskSnapshot = { remoteId: "r1", state: "completed", statusText: "completed", artifacts: [{ id: "result", name: "result", text: "ok" }] };
    const [model] = run([...withRunningTask, { type: "TaskSnapshot", taskId: "t1", snapshot: done }]);
    expect([model.tasks.t1?.state, model.tasks.t1?.artifacts]).toEqual(["completed", done.artifacts]);
  });

  test("stream updates after a terminal snapshot are ignored", () => {
    const done: TaskSnapshot = { ...working, state: "completed" };
    const [model] = run([
      ...withRunningTask,
      { type: "TaskSnapshot", taskId: "t1", snapshot: done },
      { type: "TaskUpdated", taskId: "t1", update: { state: "working", statusText: "step 2/3" } },
    ]);
    expect(model.tasks.t1?.state).toBe("completed");
  });

  test("repeated RunnerFailed backs off exponentially", () => {
    const [model] = run([
      ...withRunningTask,
      { type: "RunnerFailed", name: "local", error: "x" },
      { type: "RunnerFailed", name: "local", error: "x" },
      { type: "RunnerFailed", name: "local", error: "x" },
    ]);
    expect(model.runners.local!.nextCheckAt - model.now).toBe(4_000);
  });
});

const done: TaskSnapshot = { remoteId: "r1", state: "completed", statusText: "done", artifacts: [{ id: "jokes", name: "jokes", text: "1. ha" }] };
const finished: Msg[] = [...withRunningTask, { type: "TaskSnapshot", taskId: "t1", snapshot: done }];

describe("inbox", () => {
  test("a finished run lands in the inbox", () => {
    const [model] = run(finished);
    expect(inboxOf(model).map((t) => t.id)).toEqual(["t1"]);
  });

  test("a running task is not in the inbox", () => {
    const [model] = run(withRunningTask);
    expect(inboxOf(model)).toEqual([]);
  });

  test("AckInbox removes the run from the inbox", () => {
    const [model] = run([...finished, { type: "AckInbox", taskId: "t1" }]);
    expect(inboxOf(model)).toEqual([]);
  });

  test("AckAllInbox clears every finished run", () => {
    const [model] = run([
      ...finished,
      { type: "CreateTask", taskId: "t2", agent: "local/sys", prompt: "x" },
      { type: "DispatchFailed", taskId: "t2", error: "boom" },
      { type: "AckAllInbox" },
    ]);
    expect(inboxOf(model)).toEqual([]);
  });
});

describe("schedule", () => {
  const at = (day: string, minute: number): Msg => ({ type: "Tick", now: 1_000 + minute * 60_000, local: { day, minute } });
  const brief = { id: "morningbrief", name: "Morning brief", description: "", input: null };
  const laptop: Msg[] = [
    { type: "AddRunner", name: "laptop", transport: { kind: "direct", url: "http://m" }, token, origin: null },
    { type: "LinkUp", runner: "laptop", epoch: 0, url: "http://m" },
    { type: "RunnerOk", name: "laptop", agents: [brief], location: null, available: null },
  ];
  const scheduled: Msg[] = [
    at("2026-11-20", 6 * 60),
    ...laptop,
    { type: "SetSchedule", agent: "laptop/morningbrief", at: "07:30", prompt: "" },
  ];
  const scheduledRuns = (model: Model) => Object.values(model.tasks).filter((t) => t.trigger === "schedule").length;

  test("does not run before the scheduled time", () => {
    const [model] = run([...scheduled, at("2026-11-20", 7 * 60 + 29)]);
    expect(scheduledRuns(model)).toBe(0);
  });

  test("runs on the first tick at or after the time", () => {
    const [model] = run([...scheduled, at("2026-11-20", 7 * 60 + 30)]);
    expect(scheduledRuns(model)).toBe(1);
  });

  test("runs only once per day", () => {
    const [model] = run([...scheduled, at("2026-11-20", 7 * 60 + 30), at("2026-11-20", 9 * 60)]);
    expect(Object.keys(model.tasks)).toHaveLength(1);
  });

  test("catches up after the laptop slept through the slot", () => {
    const [model] = run([...scheduled, at("2026-11-20", 11 * 60)]);
    expect(scheduledRuns(model)).toBe(1);
  });

  test("a schedule survives the runner re-reporting its agents", () => {
    const [model] = run([...scheduled, { type: "RunnerOk", name: "laptop", agents: [brief], location: null, available: null }]);
    expect(model.agents["laptop/morningbrief"]?.schedule?.at).toBe("07:30");
  });

  test("runs again the next day", () => {
    const [model] = run([...scheduled, at("2026-11-20", 7 * 60 + 30), at("2026-11-21", 7 * 60 + 30)]);
    expect(Object.keys(model.tasks)).toHaveLength(2);
  });

  test("setting a time that already passed today waits for tomorrow", () => {
    const [model] = run([
      at("2026-11-20", 15 * 60),
      ...laptop,
      { type: "SetSchedule", agent: "laptop/morningbrief", at: "07:30", prompt: "" },
      at("2026-11-20", 15 * 60 + 1),
    ]);
    expect(scheduledRuns(model)).toBe(0);
  });

  test("an invalid time is rejected with a notification", () => {
    const [model] = run([...scheduled, { type: "SetSchedule", agent: "laptop/morningbrief", at: "7am", prompt: "" }]);
    expect([model.agents["laptop/morningbrief"]?.schedule?.at, model.notifications.at(-1)?.level]).toEqual(["07:30", "error"]);
  });

  test("turning the schedule off stops runs", () => {
    const [model] = run([...scheduled, { type: "SetSchedule", agent: "laptop/morningbrief", at: null, prompt: "" }, at("2026-11-20", 8 * 60)]);
    expect(scheduledRuns(model)).toBe(0);
  });
});

describe("chat", () => {
  test("CreateChat with text records the question and asks the model", () => {
    const [model, effects] = run([{ type: "CreateChat", chatId: "c1", fromTaskId: null, text: "hello" }]);
    expect([model.chats.c1?.messages.map((m) => m.text), model.chats.c1?.pending, effects.map((e) => e.type)]).toEqual([
      ["hello"],
      true,
      ["ChatComplete"],
    ]);
  });

  test("a chat started from a run gives the model the run as background", () => {
    const [, effects] = run([...finished, { type: "CreateChat", chatId: "c1", fromTaskId: "t1", text: "explain" }]);
    const ask = effects.find((e) => e.type === "ChatComplete");
    expect(ask?.type === "ChatComplete" && ask.system.includes("1. ha")).toBe(true);
  });

  test("ChatReplied appends the answer and clears pending", () => {
    const [model] = run([
      { type: "CreateChat", chatId: "c1", fromTaskId: null, text: "hello" },
      { type: "ChatReplied", chatId: "c1", text: "hi" },
    ]);
    expect([model.chats.c1?.messages.map((m) => m.role), model.chats.c1?.pending]).toEqual([["user", "assistant"], false]);
  });

  test("sending while a reply is pending is ignored", () => {
    const [model, effects] = run([
      { type: "CreateChat", chatId: "c1", fromTaskId: null, text: "hello" },
      { type: "SendChatMessage", chatId: "c1", text: "again" },
    ]);
    expect([model.chats.c1?.messages.length, effects]).toEqual([1, []]);
  });

  test("the follow-up sends the whole conversation", () => {
    const [, effects] = run([
      { type: "CreateChat", chatId: "c1", fromTaskId: null, text: "hello" },
      { type: "ChatReplied", chatId: "c1", text: "hi" },
      { type: "SendChatMessage", chatId: "c1", text: "how are you" },
    ]);
    const ask = effects[0];
    expect(ask?.type === "ChatComplete" && ask.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  test("Booted fails a reply that was in flight", () => {
    const [model] = run([{ type: "CreateChat", chatId: "c1", fromTaskId: null, text: "hello" }, { ...booted, now: 9_000 }]);
    expect([model.chats.c1?.pending, model.chats.c1?.error !== null]).toEqual([false, true]);
  });
});

describe("links", () => {
  test("a new runner wants its link open and is not checked before it is up", () => {
    const [model, effects] = run([{ type: "Tick", now: 1_000 }, addLocal]);
    expect([linkKeys(model), effects]).toEqual([["link:local#0"], []]);
  });

  test("LinkUp checks the runner at the link's URL", () => {
    const [model, effects] = run([{ type: "Tick", now: 1_000 }, addLocal, linkUp(0, "http://127.0.0.1:5555")]);
    expect([model.runners.local?.link, effects]).toEqual([
      { state: "up", url: "http://127.0.0.1:5555" },
      [{ type: "CheckRunner", runner: "local", url: "http://127.0.0.1:5555" }],
    ]);
  });

  test("agents are called through the link URL, not the runner's configured URL", () => {
    const [, effects] = run([
      { type: "Tick", now: 1_000 },
      addLocal,
      linkUp(0, "http://127.0.0.1:5555"),
      healthy(),
      { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "" },
    ]);
    expect(effects[0]?.type === "Dispatch" && effects[0].endpoint.url).toBe("http://127.0.0.1:5555/agents/sys");
  });

  test("LinkDown marks the runner unreachable, closes its streams and backs off", () => {
    const [model] = run([...withRunningTask, { type: "LinkDown", runner: "local", epoch: 0, error: "tunnel exited" }]);
    expect([model.runners.local?.status, streams(model), linkKeys(model)]).toEqual(["unreachable", [], []]);
  });

  test("after the backoff the link is wanted again with a new epoch", () => {
    const [model] = run([...withRunningTask, { type: "LinkDown", runner: "local", epoch: 0, error: "x" }, { type: "Tick", now: 3_000 }]);
    expect(linkKeys(model)).toEqual(["link:local#1"]);
  });

  test("a LinkUp from an old epoch is ignored", () => {
    const [model] = run([...withRunningTask, { type: "LinkDown", runner: "local", epoch: 0, error: "x" }, linkUp(0)]);
    expect(model.runners.local?.link.state).toBe("down");
  });

  test("Booted reopens links", () => {
    const [model] = run([...withRunningTask, booted]);
    expect(linkKeys(model)).toEqual(["link:local#1"]);
  });
});

describe("queued runs", () => {
  const offline: Msg[] = [{ type: "Tick", now: 1_000 }, addLocal, linkUp(), healthy(), booted];

  test("a run created while the runner is away waits instead of failing", () => {
    const [model, effects] = run([...offline, { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "x" }]);
    expect([model.tasks.t1?.state, effects]).toEqual(["queued", []]);
  });

  test("a queued run is sent once the runner answers", () => {
    const [model, effects] = run([...offline, { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "x" }, linkUp(1), healthy()]);
    expect([model.tasks.t1?.state, effects.map((e) => e.type)]).toEqual(["dispatching", ["Dispatch"]]);
  });

  test("Booted leaves a queued run queued", () => {
    const [model] = run([...offline, { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "x" }, booted]);
    expect(model.tasks.t1?.state).toBe("queued");
  });

  test("canceling a queued run needs no runner", () => {
    const [model] = run([...offline, { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "x" }, { type: "CancelTask", taskId: "t1" }]);
    expect(model.tasks.t1?.state).toBe("canceled");
  });
});

describe("adding agents", () => {
  const jokes = { id: "dadjokes", name: "Dad jokes", description: "", input: null };
  const ready: Msg[] = [{ type: "Tick", now: 1_000 }, addLocal, linkUp(), healthy([sys], [jokes])];
  const added: Msg = { type: "AgentsSet", runner: "local", added: ["dadjokes"], agents: [jokes, sys], location: "laptop", available: [] };

  test("asks the runner to serve its current agents plus the new ones", () => {
    const [, effects] = run([...ready, { type: "AddAgents", runner: "local", agents: ["dadjokes"] }]);
    expect(effects).toEqual([{ type: "SetRunnerAgents", runner: "local", endpoint: { url: "http://x", token }, agents: ["dadjokes", "sys"], added: ["dadjokes"] }]);
  });

  test("shows the agents being added until the runner answers", () => {
    const [model] = run([...ready, { type: "AddAgents", runner: "local", agents: ["dadjokes"] }]);
    expect(model.runners.local?.agentsChange).toEqual({ state: "adding", agents: ["dadjokes"] });
  });

  test("the runner's answer lists the new agent and clears the change", () => {
    const [model] = run([...ready, { type: "AddAgents", runner: "local", agents: ["dadjokes"] }, added]);
    expect([Object.keys(model.agents), model.runners.local?.agentsChange, model.runners.local?.available]).toEqual([["local/dadjokes", "local/sys"], null, []]);
  });

  test("a refusal from the runner stays on the runner with its reason", () => {
    const [model] = run([...ready, { type: "AddAgents", runner: "local", agents: ["dadjokes"] }, { type: "AgentsSetFailed", runner: "local", error: "HTTP 500" }]);
    expect(model.runners.local?.agentsChange).toEqual({ state: "failed", agents: ["dadjokes"], error: "HTTP 500" });
  });

  test("an agent the runner doesn't offer is refused without calling it", () => {
    const [model, effects] = run([...ready, { type: "AddAgents", runner: "local", agents: ["nope"] }]);
    expect([model.runners.local?.agentsChange, effects]).toEqual([{ state: "failed", agents: ["nope"], error: "local has no agent nope to add" }, []]);
  });

  test("a runner that can't change its agents is refused without calling it", () => {
    const [model, effects] = run([{ type: "Tick", now: 1_000 }, addLocal, linkUp(), healthy(), { type: "AddAgents", runner: "local", agents: ["dadjokes"] }]);
    expect([model.runners.local?.agentsChange?.state === "failed" && model.runners.local.agentsChange.error, effects]).toEqual([
      "local can't change its agents; update the runner",
      [],
    ]);
  });

  test("a runner that is down is refused without calling it", () => {
    const [, effects] = run([...ready, booted, { type: "AddAgents", runner: "local", agents: ["dadjokes"] }]);
    expect(effects).toEqual([]);
  });

  test("a restart forgets a change that never reported back", () => {
    const [model] = run([...ready, { type: "AddAgents", runner: "local", agents: ["dadjokes"] }, booted]);
    expect(model.runners.local?.agentsChange).toBeNull();
  });

  test("RunnerOk logged before runners reported availability means the runner can't change its agents", () => {
    const old = { type: "RunnerOk", name: "local", agents: [sys], location: null } as unknown as Msg;
    const [model] = run([{ type: "Tick", now: 1_000 }, addLocal, linkUp(), old]);
    expect(model.runners.local?.available).toBeNull();
  });
});

describe("creating an agent", () => {
  const poet = { name: "Haiku poet", model: "us.anthropic.claude-haiku-5-5", systemPrompt: "One haiku." };
  const creator: Msg = { type: "RunnerOk", name: "local", agents: [sys], location: "laptop", available: [], canCreate: true };
  const ready: Msg[] = [{ type: "Tick", now: 1_000 }, addLocal, linkUp(), creator];
  const made = { id: "haiku-poet", name: "Haiku poet", description: "", input: null };

  test("asks the runner to create it and shows it as being added", () => {
    const [model, effects] = run([...ready, { type: "CreateAgent", runner: "local", agent: poet }]);
    expect([model.runners.local?.agentsChange, effects]).toEqual([
      { state: "adding", agents: ["Haiku poet"] },
      [{ type: "CreateRunnerAgent", runner: "local", endpoint: { url: "http://x", token }, agent: poet }],
    ]);
  });

  test("the runner's answer lists the new agent", () => {
    const answered: Msg = { type: "AgentsSet", runner: "local", added: ["haiku-poet"], agents: [made, sys], location: "laptop", available: [], canCreate: true };
    const [model] = run([...ready, { type: "CreateAgent", runner: "local", agent: poet }, answered]);
    expect([Object.keys(model.agents), model.runners.local?.agentsChange]).toEqual([["local/haiku-poet", "local/sys"], null]);
  });

  test("a runner that can't create agents is refused without calling it", () => {
    const [model, effects] = run([{ type: "Tick", now: 1_000 }, addLocal, linkUp(), healthy(), { type: "CreateAgent", runner: "local", agent: poet }]);
    expect([model.runners.local?.agentsChange, effects]).toEqual([{ state: "failed", agents: ["Haiku poet"], error: "local can't create agents; update the runner" }, []]);
  });
});

describe("updating a runner", () => {
  const ssh = { kind: "ssh", host: "box", user: null, port: null, identityFile: null, remotePort: 9000 } as const;
  const newToken = { kind: "vault", key: "runner/local/k2" } as const;

  test("a new transport is stored and reached through a fresh link", () => {
    const [model] = run([...withRunningTask, { type: "UpdateRunner", name: "local", transport: ssh, token: null }]);
    expect([model.runners.local?.transport, model.runners.local?.token, linkKeys(model)]).toEqual([ssh, token, ["link:local#1"]]);
  });

  test("its streams close until the runner answers over the new link", () => {
    const [model] = run([...withRunningTask, { type: "UpdateRunner", name: "local", transport: ssh, token: null }]);
    expect([model.runners.local?.status, streams(model)]).toEqual(["unknown", []]);
  });

  test("a LinkUp from the old link is ignored", () => {
    const [model] = run([...withRunningTask, { type: "UpdateRunner", name: "local", transport: ssh, token: null }, linkUp(0)]);
    expect(model.runners.local?.link.state).toBe("down");
  });

  test("a replaced token's vault entry is deleted", () => {
    const [model, effects] = run([...withRunningTask, { type: "UpdateRunner", name: "local", transport: null, token: newToken }]);
    expect([model.runners.local?.token, effects]).toEqual([newToken, [{ type: "DeleteSecrets", keys: ["runner/local/k"] }]]);
  });

  test("an unknown runner is reported", () => {
    const [model] = run([{ type: "UpdateRunner", name: "nope", transport: ssh, token: null }]);
    expect(model.notifications.at(-1)?.text).toBe("unknown runner nope");
  });
});

describe("removing a runner", () => {
  const origin = { guide: "aws", summary: "EC2 i-1", teardown: { label: "terminate i-1", data: { instanceId: "i-1" } } };
  const awsRunner: Msg = { ...addLocal, origin } as Msg;

  test("its open runs become lost", () => {
    const [model] = run([...withRunningTask, { type: "RemoveRunner", name: "local", teardown: false }]);
    expect(model.tasks.t1?.state).toBe("lost");
  });

  test("retires the runner without teardown unless asked", () => {
    const [, effects] = run([{ type: "Tick", now: 1_000 }, awsRunner, { type: "RemoveRunner", name: "local", teardown: false }]);
    expect(effects).toEqual([{ type: "RetireRunner", runner: { name: "local", transport: { kind: "direct", url: "http://x" }, token, origin }, teardown: false }]);
  });

  test("asks for teardown when the user chose it and the guide offers one", () => {
    const [, effects] = run([{ type: "Tick", now: 1_000 }, awsRunner, { type: "RemoveRunner", name: "local", teardown: true }]);
    expect(effects[0]?.type === "RetireRunner" && effects[0].teardown).toBe(true);
  });

  test("never tears down a runner that has nothing to tear down", () => {
    const [, effects] = run([{ type: "Tick", now: 1_000 }, addLocal, { type: "RemoveRunner", name: "local", teardown: true }]);
    expect(effects[0]?.type === "RetireRunner" && effects[0].teardown).toBe(false);
  });
});

describe("guide sessions", () => {
  const catalogue: Msg = { type: "Booted", now: 1_000, guides: [{ id: "manual", title: "By URL", description: "" }] };
  const view = { title: "Add", fields: [{ id: "name", label: "Name", kind: "text" as const }, { id: "token", label: "Token", kind: "secret" as const }] };
  const asked: GuideResult = { kind: "ask", state: { step: "form" }, view };
  const started: Msg[] = [catalogue, { type: "StartGuide", sessionId: "g1", guide: "manual" }];

  test("a guide that is coming soon can't be started", () => {
    const soon: Msg = { type: "Booted", now: 1_000, guides: [{ id: "manual", title: "By URL", description: "", comingSoon: true }] };
    const [model, effects] = run([soon, { type: "StartGuide", sessionId: "g1", guide: "manual" }]);
    expect([model.guideSessions, effects, model.notifications.at(-1)?.text]).toEqual([{}, [], "By URL isn't available yet"]);
  });
  const atForm: Msg[] = [...started, { type: "GuideStepped", sessionId: "g1", result: asked }];
  const newRunner = { name: "home", transport: { kind: "direct" as const, url: "http://h" }, token: { kind: "vault" as const, key: "guide/g1/token/a" }, origin: null };

  test("StartGuide runs the guide's first step", () => {
    const [model, effects] = run(started);
    expect([model.guideSessions.g1?.status, effects]).toEqual(["working", [{ type: "RunGuideStep", sessionId: "g1", guide: "manual", state: null, input: null }]]);
  });

  test("an unknown guide is refused", () => {
    const [model] = run([catalogue, { type: "StartGuide", sessionId: "g1", guide: "nope" }]);
    expect([model.guideSessions, model.notifications.at(-1)?.text]).toEqual([{}, "unknown guide nope"]);
  });

  test("an ask result waits for the user", () => {
    const [model, effects] = run(atForm);
    expect([model.guideSessions.g1?.status, model.guideSessions.g1?.view, effects]).toEqual(["ask", view, []]);
  });

  test("the user's answer runs the next step and remembers secret keys", () => {
    const [model, effects] = run([...atForm, { type: "GuideInput", sessionId: "g1", input: { name: "home", token: "guide/g1/token/a" } }]);
    expect([model.guideSessions.g1?.secretKeys, effects.map((e) => e.type)]).toEqual([["guide/g1/token/a"], ["RunGuideStep"]]);
  });

  test("a working result asks for the next step right away", () => {
    const [, effects] = run([...started, { type: "GuideStepped", sessionId: "g1", result: { kind: "working", state: { n: 1 }, view } }]);
    expect(effects).toEqual([{ type: "RunGuideStep", sessionId: "g1", guide: "manual", state: { n: 1 }, input: null }]);
  });

  test("done adds the runner and ends the session", () => {
    const [model] = run([...atForm, { type: "GuideStepped", sessionId: "g1", result: { kind: "done", runner: newRunner } }]);
    expect([Object.keys(model.runners), model.guideSessions]).toEqual([["home"], {}]);
  });

  test("done deletes the secrets the runner doesn't use", () => {
    const [, effects] = run([
      ...atForm,
      { type: "GuideInput", sessionId: "g1", input: { token: "guide/g1/token/a" } },
      { type: "GuideStepped", sessionId: "g1", result: asked },
      { type: "GuideInput", sessionId: "g1", input: { token: "guide/g1/token/b" } },
      { type: "GuideStepped", sessionId: "g1", result: { kind: "done", runner: newRunner } },
    ]);
    expect(effects).toEqual([{ type: "DeleteSecrets", keys: ["guide/g1/token/b"] }]);
  });

  test("done with a taken name fails instead of replacing the runner", () => {
    const [model] = run([...atForm, { ...addLocal, name: "home" } as Msg, { type: "GuideStepped", sessionId: "g1", result: { kind: "done", runner: newRunner } }]);
    expect(model.guideSessions.g1?.status).toBe("failed");
  });

  test("input is ignored while a step is running", () => {
    const [, effects] = run([...started, { type: "GuideInput", sessionId: "g1", input: {} }]);
    expect(effects).toEqual([]);
  });

  test("Retry re-runs a failed step from its state", () => {
    const [, effects] = run([
      ...started,
      { type: "GuideStepped", sessionId: "g1", result: { kind: "failed", state: { step: "verify" }, view, error: "denied" } },
      { type: "GuideRetry", sessionId: "g1" },
    ]);
    expect(effects).toEqual([{ type: "RunGuideStep", sessionId: "g1", guide: "manual", state: { step: "verify" }, input: null }]);
  });

  test("a step running when the Controller died can be retried", () => {
    const [model] = run([...started, { ...catalogue, now: 9_000 }]);
    expect(model.guideSessions.g1?.status).toBe("failed");
  });

  test("Cancel drops the session and its secrets", () => {
    const [model, effects] = run([
      ...atForm,
      { type: "GuideInput", sessionId: "g1", input: { token: "guide/g1/token/a" } },
      { type: "CancelGuide", sessionId: "g1" },
    ]);
    expect([model.guideSessions, effects]).toEqual([{}, [{ type: "DeleteSecrets", keys: ["guide/g1/token/a"] }]]);
  });
});
