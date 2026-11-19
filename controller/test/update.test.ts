import { describe, expect, test } from "bun:test";
import type { Model, Msg, TaskSnapshot } from "../src/types.ts";
import { initialModel, subscriptions, update, WAKE_GAP_MS } from "../src/update.ts";

const run = (msgs: Msg[], start: Model = initialModel()) =>
  msgs.reduce<[Model, ReturnType<typeof update>[1]]>(([m], msg) => update(m, msg), [start, []]);

const working: TaskSnapshot = { remoteId: "r1", state: "working", statusText: "step 1/3", artifacts: [] };

const withRunningTask: Msg[] = [
  { type: "Tick", now: 1_000 },
  { type: "AddRunner", name: "local", url: "http://x/", token: "t" },
  { type: "RunnerOk", name: "local" },
  { type: "CreateTask", taskId: "t1", runner: "local", prompt: "steps=3 hi" },
  { type: "Dispatched", taskId: "t1", snapshot: working },
];

describe("update", () => {
  test("CreateTask emits a Dispatch effect for the runner", () => {
    const [, effects] = run(withRunningTask.slice(0, 4));
    expect(effects).toEqual([
      { type: "Dispatch", taskId: "t1", runner: { name: "local", url: "http://x", token: "t" }, prompt: "steps=3 hi" },
    ]);
  });

  test("CreateTask for an unknown runner adds an error notification", () => {
    const [model] = run([{ type: "CreateTask", taskId: "t1", runner: "nope", prompt: "x" }]);
    expect(model.notifications.at(-1)?.text).toBe("unknown runner nope");
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
    const [, effects] = run([...withRunningTask, { type: "Booted", now: 50_000 }, { type: "RunnerOk", name: "local" }]);
    expect(effects).toEqual([
      { type: "GetTask", taskId: "t1", runner: { name: "local", url: "http://x", token: "t" }, remoteId: "r1" },
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
