// Adds test agents to a runner through the Controller, the same intents the Fleet page sends.
// Usage: node experimental/fleet/test-agents/add.mjs [--runner laptop] [webresearch slow hello ask]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTROLLER = process.env.FLEET_URL ?? "http://127.0.0.1:7700";
const TOKEN = process.env.FLEET_TOKEN ?? readFileSync(path.join(process.env.FLEET_HOME ?? path.join(homedir(), ".agent-fleet"), "token"), "utf8").trim();
const WAIT_MS = 60_000;

const filesOf = (dir, prefix = "") =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesOf(dir, path.join(prefix, e.name)) : [{ path: path.join(prefix, e.name).split(path.sep).join("/"), content: readFileSync(path.join(dir, prefix, e.name), "utf8") }],
  );

const skillsOf = (agent) => {
  const dir = path.join(here, agent, "skills");
  return readdirSync(dir).map((id) => ({ id, files: filesOf(path.join(dir, id)) }));
};

/** Each agent: the id it gets on the runner, what it needs first, and the intent that adds it. */
const AGENTS = {
  webresearch: {
    id: "web-research",
    mcp: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
    intent: (runner) => ({
      type: "CreateAgent",
      payload: {
        runner,
        name: "Web research",
        model: "us.anthropic.claude-haiku-5-5",
        systemPrompt: readFileSync(path.join(here, "webresearch", "system.md"), "utf8"),
        mcp: ["fetch"],
        skills: skillsOf("webresearch"),
      },
    }),
  },
  slow: {
    id: "slow-test-agent",
    intent: (runner) => ({
      type: "AddPluginAgent",
      payload: {
        runner,
        plugin: "python",
        fields: {
          name: "Slow test agent",
          path: path.join(here, "slow"),
          description: "Reports progress N times, S seconds apart, then returns a result: steps=N every=S <text>. For disconnect tests; no LLM.",
        },
      },
    }),
  },
  hello: {
    id: "hello-container",
    intent: (runner) => ({
      type: "AddPluginAgent",
      payload: {
        runner,
        plugin: "docker",
        fields: {
          name: "Hello container",
          image: "alpine:3.21",
          // The command field is comma-separated, so the script holds no commas.
          command: `sh, -c, read -r task; printf '{"artifact":{"text":"Hello from a container on %s"}}\\n' "$(uname -m)"`,
          description: "Answers from an Alpine container with the machine it ran on. No LLM.",
        },
      },
    }),
  },
  ask: {
    id: "ask-claude-code",
    intent: (runner) => ({
      type: "AddPluginAgent",
      payload: {
        runner,
        plugin: "claude-code",
        fields: { name: "Ask Claude Code", project: here, description: "Answers with Claude Code, which can read the test agents folder." },
      },
    }),
  },
};

const call = async (route, init = {}) => {
  const res = await fetch(`${CONTROLLER}${route}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: body } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
};

const send = ({ type, payload }) => call("/msg", { method: "POST", body: JSON.stringify({ msg_id: crypto.randomUUID(), type, payload }) });

const runnerOf = async (name) => {
  const r = await call("/model");
  return r.ok ? r.value.model.runners[name] : undefined;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls the runner until `done` says the change landed (true), failed (a reason), or is still going (null). */
const waitFor = async (name, done) => {
  for (const until = Date.now() + WAIT_MS; Date.now() < until; await sleep(500)) {
    const result = done(await runnerOf(name));
    if (result !== null) return result;
  }
  return "timed out waiting for the runner";
};

const changeDone = (runner) => (!runner?.agentsChange ? true : runner.agentsChange.error ?? null);

const ensureMcp = async (name, servers) => {
  for (const [id, entry] of Object.entries(servers)) {
    if ((await runnerOf(name))?.mcpServers?.[id]) continue;
    const sent = await send({ type: "SetMcpServer", payload: { runner: name, id, entry } });
    if (!sent.ok) return sent.error;
    const landed = await waitFor(name, (r) => (r?.mcpServers?.[id] ? true : null));
    if (landed !== true) return `MCP server ${id}: ${landed}`;
  }
  return true;
};

const add = async (runnerName, key) => {
  const agent = AGENTS[key];
  const r = await call("/model");
  if (!r.ok) return r.error;
  if (!r.value.model.runners[runnerName]) return `the Controller has no runner ${runnerName}`;
  if (r.value.model.agents[`${runnerName}/${agent.id}`]) return "already there";
  const mcp = agent.mcp ? await ensureMcp(runnerName, agent.mcp) : true;
  if (mcp !== true) return mcp;
  const sent = await send(agent.intent(runnerName));
  if (!sent.ok) return sent.error;
  const landed = await waitFor(runnerName, changeDone);
  return landed === true ? "added" : landed;
};

const { values, positionals } = parseArgs({ options: { runner: { type: "string", default: "laptop" } }, allowPositionals: true });
const picked = positionals.length > 0 ? positionals : Object.keys(AGENTS);
const unknown = picked.filter((k) => !(k in AGENTS));
if (unknown.length > 0) {
  console.error(`unknown test agent ${unknown.join(", ")}; pick from ${Object.keys(AGENTS).join(", ")}`);
  process.exit(2);
}
const results = [];
for (const key of picked) {
  const result = await add(values.runner, key);
  results.push(result);
  console.log(`${key}: ${result}`);
}
process.exit(results.every((r) => r === "added" || r === "already there") ? 0 : 1);
