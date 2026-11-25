import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent, Task } from "./protocol.js";
import { defaultCommand, pythonHarness } from "./python.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

const agentsDir = (agents: Record<string, { toml: string; py: string }>): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-python-"));
  dirs.push(dir);
  Object.entries(agents).forEach(([id, a]) => {
    mkdirSync(path.join(dir, id));
    writeFileSync(path.join(dir, id, "agent.toml"), a.toml);
    writeFileSync(path.join(dir, id, "agent.py"), a.py);
  });
  return dir;
};

const ECHO = `import json, sys
task = json.load(sys.stdin)
print(json.dumps({"artifact": {"name": "reply", "text": task["input"]}}), flush=True)
`;

const run = async (dir: string, agent: string) => {
  const task: Task = { taskId: "t1", contextId: "c1", agent, input: "hi" };
  const job = await pythonHarness(dir).prepare(task);
  if (!job.ok) return { error: job.error };
  const events: RunEvent[] = [];
  return { events, reason: await job.value((e) => events.push(e), new AbortController().signal) };
};

describe("Python agents", () => {
  it("run a script with inline dependencies through uv", () => {
    expect(defaultCommand("# /// script\n# dependencies = []\n# ///\n")).toBe("uv run --quiet agent.py");
  });

  it("run a plain script with python3", () => {
    expect([defaultCommand("print()\n"), defaultCommand(null)]).toEqual(["python3 agent.py", "python3 agent.py"]);
  });

  it("are the folders with an agent.toml, by id", async () => {
    const dir = agentsDir({ b: { toml: 'name = "B"\n[input]\nlabel = "Topic"\n', py: "" }, a: { toml: 'name = "A"\ntimeout_secs = 30\n', py: "" } });
    writeFileSync(path.join(dir, "notes.txt"), "not an agent");
    expect(await pythonHarness(dir).agents()).toEqual([
      { id: "a", name: "A", timeoutSecs: 30 },
      { id: "b", name: "B", input: { label: "Topic" } },
    ]);
  });

  it("skip a folder whose agent.toml doesn't parse", async () => {
    const dir = agentsDir({ good: { toml: 'name = "Good"\n', py: "" }, bad: { toml: "name = ", py: "" } });
    expect((await pythonHarness(dir).agents()).map((a) => a.id)).toEqual(["good"]);
  });

  it("run with the task on stdin and relay the reply", async () => {
    expect(await run(agentsDir({ echo: { toml: 'name = "Echo"\n', py: ECHO } }), "echo")).toEqual({ events: [{ artifact: { name: "reply", text: "hi" } }], reason: null });
  });

  it("fail with the agent's last stderr line when it crashes", async () => {
    const crash = 'import sys\nprint("it broke", file=sys.stderr)\nsys.exit(1)\n';
    expect(await run(agentsDir({ crash: { toml: 'name = "Crash"\n', py: crash } }), "crash")).toEqual({ events: [], reason: "it broke" });
  });

  it("refuse an agent that isn't there", async () => {
    expect(await run(agentsDir({}), "nope")).toEqual({ error: 'there is no Python agent "nope"' });
  });
});
