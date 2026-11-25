import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeArgs, claudeCodeHarness, NO_INPUT, translate, type ClaudeAgent } from "./claude-code.js";
import type { RunEvent } from "./protocol.js";

/** The plugin's shipped agents in `dir`, and the ones added from the Fleet page inside it (a folder without agent.toml). */
const dirsOf = (dir: string) => ({ shipped: dir, added: path.join(dir, ".added") });



const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

const AGENT: ClaudeAgent = { info: { id: "ask", name: "Ask" }, project: "/p", allowedTools: [], env: {} };

// Stands in for `claude`: prints what `claude -p --output-format stream-json` prints, and records its arguments.
const FAKE_CLAUDE = `
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, "calls.jsonl"), JSON.stringify(args) + "\\n");
const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "s-1";
const prompt = args[args.indexOf("-p") + 1];
[
  { type: "system", subtype: "init", model: "sonnet", session_id: session },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] }, session_id: session },
  { type: "result", subtype: "success", is_error: false, result: "answer to " + prompt, session_id: session },
].forEach((l) => console.log(JSON.stringify(l)));
`;

describe("the claude command", () => {
  it("asks for streamed JSON with the agent's settings", () => {
    expect(claudeArgs({ ...AGENT, model: "opus", allowedTools: ["Read", "Grep"], maxTurns: 3 }, "hi", undefined)).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--verbose", "--model", "opus", "--allowedTools", "Read,Grep", "--max-turns", "3",
    ]);
  });

  it("resumes the conversation of a follow-up", () => {
    expect(claudeArgs(AGENT, "and?", "s-9").slice(-2)).toEqual(["--resume", "s-9"]);
  });

  it("still sends a prompt for an empty input", () => {
    expect(claudeArgs(AGENT, "", undefined)[1]).toBe(NO_INPUT);
  });
});

describe("Claude Code's stream", () => {
  it("becomes progress, tool use and the final answer", () => {
    const lines = [
      { type: "system", subtype: "init", model: "sonnet" },
      { type: "assistant", message: { content: [{ type: "text", text: "Let me look.\nmore" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep" }] } },
      { type: "result", subtype: "success", is_error: false, result: "Done." },
    ];
    expect(lines.flatMap((l) => translate(JSON.stringify(l)))).toEqual([
      { status: "Claude Code started (sonnet)" },
      { status: "Let me look." },
      { status: "using Grep" },
      { artifact: { name: "reply", text: "Done." } },
      { status: "answered" },
    ]);
  });

  it("turns a failed result into an error", () => {
    expect(translate(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual([{ error: "Claude Code stopped: error_max_turns" }]);
  });

  it("hands on the session id", () => {
    const seen: string[] = [];
    translate(JSON.stringify({ type: "system", subtype: "hook_started", session_id: "s-7" }), (id) => seen.push(id));
    expect(seen).toEqual(["s-7"]);
  });

  it("ignores what isn't stream JSON", () => {
    expect(translate("warning: something")).toEqual([]);
  });
});

const setup = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-claude-"));
  dirs.push(root);
  writeFileSync(path.join(root, "claude.cjs"), FAKE_CLAUDE);
  mkdirSync(path.join(root, "agents", "ask"), { recursive: true });
  writeFileSync(path.join(root, "agents", "ask", "agent.toml"), 'name = "Ask"\nproject = "."\n');
  process.env.FAKE_CLAUDE_STATE = root;
  const harness = claudeCodeHarness(dirsOf(path.join(root, "agents")), [process.execPath, path.join(root, "claude.cjs")], path.join(root, "sessions.json"));
  const run = async (taskId: string, contextId: string, input: string) => {
    const job = await harness.prepare({ taskId, contextId, agent: "ask", input });
    const events: RunEvent[] = [];
    const reason = job.ok ? await job.value((e) => events.push(e), new AbortController().signal) : job.error;
    return { events, reason };
  };
  const calls = () => readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  return { harness, run, calls };
};

describe("Claude Code agents", () => {

  it("relay a run", async () => {
    expect(await setup().run("t1", "c1", "hi")).toEqual({
      events: [{ status: "Claude Code started (sonnet)" }, { status: "using Read" }, { artifact: { name: "reply", text: "answer to hi" } }, { status: "answered" }],
      reason: null,
    });
  });

  it("resume a conversation on a follow-up, and not across conversations", async () => {
    const { run, calls } = setup();
    await run("t1", "c1", "first");
    await new Promise((r) => setTimeout(r, 50));
    await run("t2", "c1", "follow-up");
    await run("t3", "c2", "unrelated");
    expect(calls().map((c) => c.includes("--resume"))).toEqual([false, true, false]);
  });

  it("are healthy when claude answers", async () => {
    expect(await setup().harness.health()).toEqual({ ok: true, detail: "2.1.0 (Claude Code), 1 agent" });
  });

  it("refuse to run in a project folder that doesn't exist", async () => {
    const { harness } = setup();
    const job = await harness.prepare({ taskId: "t1", contextId: "c", agent: "ask", input: "" });
    const missing = claudeCodeHarness(dirsOf(path.join(os.tmpdir(), "no-such-agents")), ["claude"], "/tmp/x.json");
    expect([job.ok, (await missing.prepare({ taskId: "t", contextId: "c", agent: "ask", input: "" })).ok]).toEqual([true, false]);
  });
});

describe("adding Claude Code agents", () => {
  it("adds a project folder with its allowed tools", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "fleet-claude-project-"));
    dirs.push(project);
    const { harness, run, calls } = setup();
    const added = await harness.adding!.add({ name: "Repo helper", project, allowed_tools: "Read, Grep" });
    await run("t1", "c1", "hi");
    const job = await harness.prepare({ taskId: "t2", contextId: "c2", agent: "repo-helper", input: "hi" });
    if (job.ok) await job.value(() => {}, new AbortController().signal);
    expect([added, calls().at(-1)?.slice(-2)]).toEqual([{ ok: true, value: "repo-helper" }, ["--allowedTools", "Read,Grep"]]);
  });

  it("refuses a project folder that doesn't exist", async () => {
    const { harness } = setup();
    expect((await harness.adding!.add({ name: "X", project: "/no/such/repo" })).ok).toBe(false);
  });
});
