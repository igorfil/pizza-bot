import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent, Task } from "./protocol.js";
import { defaultCommand, pythonHarness } from "./python.js";

/** The plugin's shipped agents in `dir`, and the ones added from the Fleet page inside it (a folder without agent.toml). */
const dirsOf = (dir: string) => ({ shipped: dir, added: path.join(dir, ".added") });


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
  const job = await pythonHarness(dirsOf(dir)).prepare(task);
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
    expect(await pythonHarness(dirsOf(dir)).agents()).toEqual([
      { id: "a", name: "A", timeoutSecs: 30 },
      { id: "b", name: "B", input: { label: "Topic" } },
    ]);
  });

  it("skip a folder whose agent.toml doesn't parse", async () => {
    const dir = agentsDir({ good: { toml: 'name = "Good"\n', py: "" }, bad: { toml: "name = ", py: "" } });
    expect((await pythonHarness(dirsOf(dir)).agents()).map((a) => a.id)).toEqual(["good"]);
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

describe("adding Python agents", () => {
  const elsewhere = () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "fleet-python-elsewhere-"));
    dirs.push(folder);
    writeFileSync(path.join(folder, "agent.py"), ECHO);
    return folder;
  };

  it("adds one that runs in its folder elsewhere on the machine", async () => {
    const harness = pythonHarness(dirsOf(agentsDir({})));
    const added = await harness.adding!.add({ name: "Weekly report", path: elsewhere() });
    const job = await harness.prepare({ taskId: "t1", contextId: "c", agent: "weekly-report", input: "hi" });
    const events: RunEvent[] = [];
    const reason = job.ok ? await job.value((e) => events.push(e), new AbortController().signal) : job.error;
    expect([added, await harness.agents(), events, reason]).toEqual([
      { ok: true, value: "weekly-report" },
      [{ id: "weekly-report", name: "Weekly report", added: true }],
      [{ artifact: { name: "reply", text: "hi" } }],
      null,
    ]);
  });

  it("refuses a folder without agent.py unless a command says how to start it", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "fleet-python-empty-"));
    dirs.push(empty);
    const adding = pythonHarness(dirsOf(agentsDir({}))).adding!;
    const [without, withCommand] = [await adding.add({ name: "A", path: empty }), await adding.add({ name: "B", path: empty, command: "python3 main.py" })];
    expect([without.ok, withCommand.ok]).toEqual([false, true]);
  });

  it("refuses a relative or missing folder, a missing name, and a name already taken", async () => {
    const adding = pythonHarness(dirsOf(agentsDir({ echo: { toml: 'name = "Echo"\n', py: ECHO } }))).adding!;
    const results = await Promise.all([
      adding.add({ name: "A", path: "agents/a" }),
      adding.add({ name: "A", path: "/no/such/folder" }),
      adding.add({ path: elsewhere() }),
      adding.add({ name: "Echo", path: elsewhere() }),
    ]);
    expect(results.map((r) => (r.ok ? "added" : r.error))).toEqual([
      "Folder must be an absolute path on the runner's machine",
      "Folder /no/such/folder isn't a folder on the runner's machine",
      "Name is required",
      'there is already an agent "echo"; pick another name',
    ]);
  });

  it("removes an added agent, and only disables a shipped one", async () => {
    const harness = pythonHarness(dirsOf(agentsDir({ echo: { toml: 'name = "Echo"\n', py: ECHO } })));
    await harness.adding!.add({ name: "Mine", path: elsewhere() });
    const [mine, shipped] = [await harness.adding!.remove("mine"), await harness.adding!.remove("echo")];
    expect([mine.ok, shipped.ok, (await harness.agents()).map((a) => a.id)]).toEqual([true, false, ["echo"]]);
  });
});
