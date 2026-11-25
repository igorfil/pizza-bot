import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { fail, ok, serve, type Harness, type Job } from "./protocol.js";

/** Drives `serve` the way the runner does: requests in, replies and run events out. */
const session = (harness: Harness) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts.map((p) => JSON.parse(p) as Record<string, unknown>));
  });
  const served = serve(harness, { input, output });
  let id = 0;
  const until = async (stop: (line: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 400 && !lines.some(stop); i++) await new Promise((r) => setTimeout(r, 5));
    return lines;
  };
  return {
    lines,
    served,
    request: (method: string, params: object = {}) => {
      id += 1;
      input.write(`${JSON.stringify({ id, method, params })}\n`);
      return id;
    },
    reply: async (rid: number) => (await until((l) => l.id === rid)).find((l) => l.id === rid),
    done: async (taskId: string) => (await until((l) => l.taskId === taskId && l.done === true)).filter((l) => l.taskId === taskId),
    close: () => input.end(),
  };
};

const harness = (job: Job, over: Partial<Harness> = {}): Harness => ({
  name: "Test",
  version: "7",
  capabilities: ["cancel"],
  health: async () => ({ ok: true, detail: "fine" }),
  agents: async () => [{ id: "a", name: "A" }],
  prepare: async (task) => (task.agent === "a" ? ok(job) : fail(`no agent ${task.agent}`)),
  ...over,
});

const quick: Job = async (emit) => {
  emit({ status: "working" });
  emit({ artifact: { name: "reply", text: "hi" } });
  return null;
};

const waitForAbort: Job = (_emit, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));

describe("serve", () => {
  it("describes the plugin", async () => {
    const s = session(harness(quick));
    expect(await s.reply(s.request("describe"))).toEqual({ id: 1, result: { name: "Test", version: "7", capabilities: ["cancel"] } });
  });

  it("lists the agents", async () => {
    const s = session(harness(quick));
    expect(await s.reply(s.request("agents"))).toEqual({ id: 1, result: { agents: [{ id: "a", name: "A" }] } });
  });

  it("answers an unknown method with an error", async () => {
    const s = session(harness(quick));
    expect(await s.reply(s.request("nope"))).toEqual({ id: 1, error: 'unknown method "nope"' });
  });

  it("relays a run's events and ends it with done", async () => {
    const s = session(harness(quick));
    s.request("run", { taskId: "t1", contextId: "c", agent: "a", input: "x" });
    expect(await s.done("t1")).toEqual([
      { taskId: "t1", status: "working" },
      { taskId: "t1", artifact: { name: "reply", text: "hi" } },
      { taskId: "t1", done: true },
    ]);
  });

  it("refuses a run that can't start, without events", async () => {
    const s = session(harness(quick));
    const rid = s.request("run", { taskId: "t1", agent: "b" });
    expect([await s.reply(rid), s.lines.filter((l) => l.taskId)]).toEqual([{ id: rid, error: "no agent b" }, []]);
  });

  it("ends a failed run with its reason before done", async () => {
    const s = session(harness(async () => "it broke"));
    s.request("run", { taskId: "t1", agent: "a" });
    expect(await s.done("t1")).toEqual([
      { taskId: "t1", error: "it broke" },
      { taskId: "t1", done: true },
    ]);
  });

  it("ends a canceled run with done only", async () => {
    const s = session(harness(waitForAbort));
    s.request("run", { taskId: "t1", agent: "a" });
    await s.reply(1);
    s.request("cancel", { taskId: "t1" });
    expect(await s.done("t1")).toEqual([{ taskId: "t1", done: true }]);
  });

  it("stops every run when the runner closes stdin", async () => {
    const s = session(harness(waitForAbort));
    s.request("run", { taskId: "t1", agent: "a" });
    await s.reply(1);
    s.close();
    await s.served;
    expect(s.lines.filter((l) => l.taskId)).toEqual([{ taskId: "t1", done: true }]);
  });
});
