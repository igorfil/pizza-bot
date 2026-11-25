import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containerName, dockerHarness, runArgs, type DockerAgent } from "./docker.js";
import type { RunEvent } from "./protocol.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

// Stands in for the docker CLI: `run` speaks the agent contract (or waits, for the "sleepy" image), `kill` stops that run.
const FAKE_DOCKER = `
const fs = require("node:fs"), path = require("node:path");
const state = process.env.FAKE_DOCKER_STATE, args = process.argv.slice(2);
if (args[0] === "version") console.log("29.0");
else if (args[0] === "kill") process.kill(Number(fs.readFileSync(path.join(state, args[1]), "utf8")), "SIGTERM");
else if (args[0] === "run") {
  const name = args[args.indexOf("--name") + 1];
  fs.writeFileSync(path.join(state, name), String(process.pid));
  fs.writeFileSync(path.join(state, "last-run.json"), JSON.stringify(args));
  let input = "";
  process.stdin.on("data", (d) => (input += d)).on("end", () => {
    if (args.includes("sleepy")) return setTimeout(() => {}, 60_000);
    console.log(JSON.stringify({ artifact: { name: "reply", text: "got " + JSON.parse(input).input } }));
  });
}
`;

const setup = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-docker-"));
  dirs.push(root);
  mkdirSync(path.join(root, "state"));
  writeFileSync(path.join(root, "docker.cjs"), FAKE_DOCKER);
  [
    ["echo", "me/echo:1"],
    ["sleepy", "sleepy"],
  ].forEach(([id, image]) => {
    mkdirSync(path.join(root, "agents", id!), { recursive: true });
    writeFileSync(path.join(root, "agents", id!, "agent.toml"), `name = "${id}"\nimage = "${image}"\n[env]\nMODEL = "m"\n`);
  });
  process.env.FAKE_DOCKER_STATE = path.join(root, "state");
  return { root, harness: dockerHarness(path.join(root, "agents"), [process.execPath, path.join(root, "docker.cjs")]) };
};

const agent: DockerAgent = { info: { id: "a", name: "A" }, image: "me/agent:1", command: ["python", "agent.py"], args: ["--network", "none"], env: { MODEL: "m" } };

describe("Docker agents", () => {
  it("run the image interactively with their env, args and command", () => {
    expect(runArgs(agent, "t1")).toEqual(["run", "--rm", "-i", "--init", "--name", "fleet-t1", "--env", "MODEL=m", "--env", "FLEET_TASK_ID=t1", "--network", "none", "me/agent:1", "python", "agent.py"]);
  });

  it("name the container after the run, in characters docker accepts", () => {
    expect(containerName("schedule:laptop/a:2026-11-25")).toBe("fleet-schedule-laptop-a-2026-11-25");
  });

  it("skip an agent without an image", async () => {
    const { root, harness } = setup();
    mkdirSync(path.join(root, "agents", "noimage"));
    writeFileSync(path.join(root, "agents", "noimage", "agent.toml"), 'name = "No image"\n');
    expect((await harness.agents()).map((a) => a.id)).toEqual(["echo", "sleepy"]);
  });

  it("are healthy when the daemon answers", async () => {
    expect(await setup().harness.health()).toEqual({ ok: true, detail: "Docker 29.0, 2 agents" });
  });

  it("are unhealthy, with the reason, when docker can't run", async () => {
    const health = await dockerHarness(os.tmpdir(), ["/nonexistent/docker"]).health();
    expect([health.ok, health.detail.startsWith("docker isn't usable")]).toEqual([false, true]);
  });

  it("run the container and relay what it says", async () => {
    const { root, harness } = setup();
    const job = await harness.prepare({ taskId: "t1", contextId: "c", agent: "echo", input: "hi" });
    const events: RunEvent[] = [];
    const reason = job.ok ? await job.value((e) => events.push(e), new AbortController().signal) : job.error;
    const args = JSON.parse(readFileSync(path.join(root, "state", "last-run.json"), "utf8")) as string[];
    expect([events, reason, args.includes("MODEL=m")]).toEqual([[{ artifact: { name: "reply", text: "got hi" } }], null, true]);
  });

  it("kill the container on cancel", async () => {
    const { harness } = setup();
    const job = await harness.prepare({ taskId: "t2", contextId: "c", agent: "sleepy", input: "" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const reason = job.ok ? await job.value(() => {}, controller.signal) : job.error;
    expect([reason, Date.now() - started < 4_000]).toEqual([null, true]);
  });
});
