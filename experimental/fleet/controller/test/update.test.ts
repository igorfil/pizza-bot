import { describe, expect, test } from "bun:test";
import type { Model, Msg, TaskSnapshot } from "../src/types.ts";
import { inboxOf, initialModel, subscriptions, update, WAKE_GAP_MS } from "../src/update.ts";

const run = (msgs: Msg[], start: Model = initialModel()) =>
  msgs.reduce<[Model, ReturnType<typeof update>[1]]>(([m], msg) => update(m, msg), [start, []]);

const working: TaskSnapshot = { remoteId: "r1", state: "working", statusText: "step 1/3", artifacts: [] };

const sys = { id: "sys", name: "System report", description: "", input: null };
const healthy = (agents = [sys]): Msg => ({ type: "RunnerOk", name: "local", agents, location: "laptop" });
const ep = { url: "http://x/agents/sys", token: "t" };

const withRunningTask: Msg[] = [
  { type: "Tick", now: 1_000 },
  { type: "AddRunner", name: "local", url: "http://x/", token: "t" },
  healthy(),
  { type: "CreateTask", taskId: "t1", agent: "local/sys", prompt: "steps=3 hi" },
  { type: "Dispatched", taskId: "t1", snapshot: working },
];

describe("update", () => {
  test("CreateTask emits a Dispatch effect for the runner", () => {
    const [, effects] = run(withRunningTask.slice(0, 4));
    expect(effects).toEqual([
      { type: "Dispatch", taskId: "t1", endpoint: ep, prompt: "steps=3 hi" },
    ]);
  });

  test("CreateTask for an unknown agent adds an error notification", () => {
    const [model] = run([{ type: "CreateTask", taskId: "t1", agent: "nope/x", prompt: "x" }]);
    expect(model.notifications.at(-1)?.text).toBe("unknown agent nope/x");
  });

  test("RunnerOk registers the runner's agents under runner/id keys", () => {
    const [model] = run(withRunningTask.slice(0, 3));
    expect(Object.keys(model.agents)).toEqual(["local/sys"]);
  });

  test("an agent the runner stops serving disappears", () => {
    const [model] = run([...withRunningTask.slice(0, 3), healthy([])]);
    expect(model.agents).toEqual({});
  });

  test("RemoveRunner removes its agents", () => {
    const [model] = run([...withRunningTask.slice(0, 3), { type: "RemoveRunner", name: "local" }]);
    expect(model.agents).toEqual({});
  });

  test("a running task on a healthy runner has one stream subscription", () => {
    const [model] = run(withRunningTask);
    expect(subscriptions(model).map((s) => s.key)).toEqual(["t1#0"]);
  });

  test("StreamDropped bumps the epoch, backs off, and re-fetches the task", () => {
    const [model, effects] = run([...withRunningTask, { type: "StreamDropped", taskId: "t1", epoch: 0, error: "reset" }]);
    expect([model.tasks.t1?.streamEpoch, subscriptions(model), effects.map((e) => e.type)]).toEqual([1, [], ["GetTask"]]);
  });

  test("a stale StreamDropped from an old epoch is ignored", () => {
    const [before] = run([...withRunningTask, { type: "StreamDropped", taskId: "t1", epoch: 0, error: null }]);
    const [after, effects] = update(before, { type: "StreamDropped", taskId: "t1", epoch: 0, error: null });
    expect([after.tasks.t1?.streamEpoch, effects]).toEqual([1, []]);
  });

  test("a Tick after a long gap drops runners to unknown and re-checks them", () => {
    const [, effects] = run([...withRunningTask, { type: "Tick", now: 1_000 + WAKE_GAP_MS + 1 }]);
    expect(effects.map((e) => e.type)).toContain("CheckRunner");
  });

  test("after wake there are no streams until the runner answers", () => {
    const [model] = run([...withRunningTask, { type: "Tick", now: 1_000 + WAKE_GAP_MS + 1 }]);
    expect(subscriptions(model)).toEqual([]);
  });

  test("RunnerOk after being unknown re-fetches that runner's open tasks", () => {
    const [, effects] = run([...withRunningTask, { type: "Booted", now: 50_000 }, healthy()]);
    expect(effects).toEqual([
      { type: "GetTask", taskId: "t1", endpoint: ep, remoteId: "r1" },
    ]);
  });

  test("Booted marks in-flight dispatches as lost", () => {
    const [model] = run([...withRunningTask.slice(0, 4), { type: "Booted", now: 50_000 }]);
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
    { type: "AddRunner", name: "laptop", url: "http://m", token: "t" },
    { type: "RunnerOk", name: "laptop", agents: [brief], location: null },
  ];
  const scheduled: Msg[] = [
    at("2026-11-20", 6 * 60),
    ...laptop,
    { type: "SetSchedule", agent: "laptop/morningbrief", at: "07:30", prompt: "" },
  ];
  const dispatches = (effects: ReturnType<typeof update>[1]) => effects.filter((e) => e.type === "Dispatch").length;

  test("does not run before the scheduled time", () => {
    const [, effects] = run([...scheduled, at("2026-11-20", 7 * 60 + 29)]);
    expect(dispatches(effects)).toBe(0);
  });

  test("runs on the first tick at or after the time", () => {
    const [model, effects] = run([...scheduled, at("2026-11-20", 7 * 60 + 30)]);
    expect([dispatches(effects), Object.values(model.tasks)[0]?.trigger]).toEqual([1, "schedule"]);
  });

  test("runs only once per day", () => {
    const [model] = run([...scheduled, at("2026-11-20", 7 * 60 + 30), at("2026-11-20", 9 * 60)]);
    expect(Object.keys(model.tasks)).toHaveLength(1);
  });

  test("catches up after the laptop slept through the slot", () => {
    const [, effects] = run([...scheduled, at("2026-11-20", 11 * 60)]);
    expect(dispatches(effects)).toBe(1);
  });

  test("a schedule survives the runner re-reporting its agents", () => {
    const [model] = run([...scheduled, { type: "RunnerOk", name: "laptop", agents: [brief], location: null }]);
    expect(model.agents["laptop/morningbrief"]?.schedule?.at).toBe("07:30");
  });

  test("runs again the next day", () => {
    const [model] = run([...scheduled, at("2026-11-20", 7 * 60 + 30), at("2026-11-21", 7 * 60 + 30)]);
    expect(Object.keys(model.tasks)).toHaveLength(2);
  });

  test("setting a time that already passed today waits for tomorrow", () => {
    const [, effects] = run([
      at("2026-11-20", 15 * 60),
      ...laptop,
      { type: "SetSchedule", agent: "laptop/morningbrief", at: "07:30", prompt: "" },
      at("2026-11-20", 15 * 60 + 1),
    ]);
    expect(dispatches(effects)).toBe(0);
  });

  test("an invalid time is rejected with a notification", () => {
    const [model] = run([...scheduled, { type: "SetSchedule", agent: "laptop/morningbrief", at: "7am", prompt: "" }]);
    expect([model.agents["laptop/morningbrief"]?.schedule?.at, model.notifications.at(-1)?.level]).toEqual(["07:30", "error"]);
  });

  test("turning the schedule off stops runs", () => {
    const [, effects] = run([...scheduled, { type: "SetSchedule", agent: "laptop/morningbrief", at: null, prompt: "" }, at("2026-11-20", 8 * 60)]);
    expect(dispatches(effects)).toBe(0);
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
    const [model] = run([{ type: "CreateChat", chatId: "c1", fromTaskId: null, text: "hello" }, { type: "Booted", now: 9_000 }]);
    expect([model.chats.c1?.pending, model.chats.c1?.error !== null]).toEqual([false, true]);
  });
});
