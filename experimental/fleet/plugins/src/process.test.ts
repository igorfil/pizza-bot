import { describe, expect, it } from "vitest";
import { contractEvent, failure, oneShot } from "./process.js";
import type { RunEvent } from "./protocol.js";

const task = { taskId: "t1", contextId: "c1", agent: "a", input: "hello" };

const run = async (script: string, signal = new AbortController().signal) => {
  const events: RunEvent[] = [];
  const reason = await oneShot({ command: "sh", args: ["-c", script], label: "test" }, task, (e) => events.push(e), signal);
  return { events, reason };
};

describe("the one-shot agent contract", () => {
  it("reads status, artifact and error lines", () => {
    const lines = ['{"status": "step 1"}', '{"artifact": {"name": "r", "text": "hi"}}', '{"error": "boom"}'];
    expect(lines.map(contractEvent)).toEqual([[{ status: "step 1" }], [{ artifact: { name: "r", text: "hi" } }], [{ error: "boom" }]]);
  });

  it("ignores lines that aren't events", () => {
    expect(["Resolved 3 packages", "[1]", '{"progress": 1}'].map(contractEvent)).toEqual([[], [], []]);
  });

  it.each([
    [{ code: 0, stderrTail: ["noise"] }, false, null],
    [{ code: 1, stderrTail: ["Traceback"] }, true, null],
    [{ code: 1, stderrTail: ["KeyError: x"] }, false, "KeyError: x"],
    [{ code: 2, stderrTail: [] }, false, "exited with code 2"],
    [{ code: null, stderrTail: [] }, false, "killed by a signal"],
  ])("exit %j with an error event %s fails with %j", (exit, errored, reason) => {
    expect(failure(exit, errored)).toBe(reason);
  });
});

describe("a one-shot run", () => {
  it("gets the task on stdin and relays what the process says", async () => {
    const agent = `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      console.log(JSON.stringify({ status: "got it" }));
      console.log(JSON.stringify({ artifact: { name: "reply", text: JSON.parse(s).input } }));
    });`;
    const events: RunEvent[] = [];
    const reason = await oneShot({ command: process.execPath, args: ["-e", agent], label: "test" }, task, (e) => events.push(e), new AbortController().signal);
    expect([events, reason]).toEqual([[{ status: "got it" }, { artifact: { name: "reply", text: "hello" } }], null]);
  });

  it("fails a crash with the last stderr line", async () => {
    expect(await run("echo 'it broke' >&2; exit 1")).toEqual({ events: [], reason: "it broke" });
  });

  it("fails a command that can't start", async () => {
    const reason = await oneShot({ command: "/nonexistent/agent", args: [], label: "x" }, task, () => {}, new AbortController().signal);
    expect(reason).toContain("could not start /nonexistent/agent");
  });

  it("cancel stops the whole process group quickly, without a failure", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = run("sleep 30 & sleep 30; wait", controller.signal);
    setTimeout(() => controller.abort(), 200);
    expect([await running, Date.now() - started < 4_000]).toEqual([{ events: [], reason: null }, true]);
  });
});
