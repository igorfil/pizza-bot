import { describe, expect, it } from "vitest";
import { createApi, transportFacts } from "./api.js";
import type { Runtime } from "./runtime.js";
import type { Model, Msg } from "./types.js";
import { initialModel } from "./update.js";
import { memoryVault, type SecretStore } from "./vault.js";

const TOKEN = "secret";
const ORIGIN = "http://localhost:5173";

const model: Model = {
  ...initialModel(),
  runners: {
    laptop: {
      name: "laptop",
      transport: { kind: "direct", url: "http://r" },
      token: { kind: "inline", value: "runner-token" },
      origin: null,
      link: { state: "up", url: "http://r" },
      linkEpoch: 0,
      linkFailures: 0,
      linkRetryAt: 0,
      status: "healthy",
      failures: 0,
      nextCheckAt: 0,
      lastSeenAt: 0,
      lastError: null,
      location: null,
      canCreateAgents: false,
      harnesses: [],
      plugins: [],
      mcpServers: {},
      agentsChange: null,
    },
  },
  guideSessions: {
    g1: {
      id: "g1",
      guide: "manual",
      status: "ask",
      state: { step: "form" },
      view: { title: "Add", fields: [{ id: "name", label: "Name", kind: "text" }, { id: "token", label: "Token", kind: "secret" }] },
      error: null,
      secretKeys: [],
      attempt: 0,
      createdAt: 0,
      updatedAt: 0,
    },
  },
};

const fakeRuntime = (sent: Msg[] = []): Runtime => ({
  send: (_id, msg) => {
    sent.push(msg);
    return { version: sent.length, duplicate: false };
  },
  snapshot: () => ({ version: 7, model }),
  onChange: () => () => {},
});

const api = (sent?: Msg[], vault: SecretStore = memoryVault()) => createApi(fakeRuntime(sent), { token: TOKEN, allowedOrigins: new Set([ORIGIN]), vault });
const auth = { authorization: `Bearer ${TOKEN}` };

const post = (body: unknown, sent?: Msg[], vault?: SecretStore) =>
  api(sent, vault).request("/msg", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("api", () => {
  it("rejects requests without the token", async () => {
    expect((await api().request("/model")).status).toBe(401);
  });

  it("rejects browser origins that are not allowed", async () => {
    const res = await api().request("/model", { headers: { ...auth, origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("answers preflight for an allowed origin without a token", async () => {
    const res = await api().request("/msg", { method: "OPTIONS", headers: { origin: ORIGIN } });
    expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([204, ORIGIN]);
  });

  it("adds CORS headers for an allowed origin", async () => {
    const res = await api().request("/model", { headers: { ...auth, origin: ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("never sends runner tokens to UIs", async () => {
    const body = (await (await api().request("/model", { headers: auth })).json()) as { model: Model };
    expect("token" in body.model.runners.laptop!).toBe(false);
  });

  it("returns the id it minted for a new task", async () => {
    const sent: Msg[] = [];
    const body = (await (await post({ msg_id: "m1", type: "CreateTask", payload: { agent: "laptop/x", prompt: "" } }, sent)).json()) as {
      id: string;
    };
    expect(body.id).toBe(sent[0]?.type === "CreateTask" ? sent[0].taskId : "missing");
  });

  it("refuses world messages from UIs", async () => {
    expect((await post({ msg_id: "m1", type: "Tick", payload: {} })).status).toBe(400);
  });

  it("explains a malformed intent", async () => {
    const body = (await (await post({ msg_id: "m1", type: "CreateTask", payload: {} })).json()) as { error: string };
    expect(body.error).toContain("CreateTask needs agent");
  });

  it("streams the model as server-sent events", async () => {
    const res = await api().request("/model/stream", { headers: auth });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const frame = new TextDecoder().decode(value);
    const data = frame.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
    expect([res.headers.get("content-type"), frame.split("\n").includes("id: 7"), (JSON.parse(data) as { version: number }).version]).toEqual([
      "text/event-stream",
      true,
      7,
    ]);
  });

  it("never sends guide state or secret keys to UIs", async () => {
    const body = (await (await api().request("/model", { headers: auth })).json()) as { model: Model };
    expect(["state" in body.model.guideSessions.g1!, "secretKeys" in body.model.guideSessions.g1!]).toEqual([false, false]);
  });

  it("AddRunner stores the token in the vault and logs only its key", async () => {
    const sent: Msg[] = [];
    const vault = memoryVault();
    await post({ msg_id: "m1", type: "AddRunner", payload: { name: "home", url: "http://h/", token: "s3cret" } }, sent, vault);
    const msg = sent[0];
    const key = msg?.type === "AddRunner" && msg.token.kind === "vault" ? msg.token.key : "";
    expect([JSON.stringify(sent).includes("s3cret"), (await vault.get(key)).ok && (await vault.get(key))]).toEqual([false, { ok: true, value: "s3cret" }]);
  });

  it("a secret guide field goes to the vault; the logged input holds its key", async () => {
    const sent: Msg[] = [];
    const vault = memoryVault();
    await post({ msg_id: "m1", type: "GuideInput", payload: { sessionId: "g1", input: { name: "home", token: "s3cret" } } }, sent, vault);
    const msg = sent[0];
    const key = msg?.type === "GuideInput" ? (msg.input.token ?? "") : "";
    expect([JSON.stringify(sent).includes("s3cret"), msg?.type === "GuideInput" && msg.input.name, await vault.get(key)]).toEqual([
      false,
      "home",
      { ok: true, value: "s3cret" },
    ]);
  });

  it("returns the session id it minted for StartGuide", async () => {
    const sent: Msg[] = [];
    const body = (await (await post({ msg_id: "m1", type: "StartGuide", payload: { guide: "aws" } }, sent)).json()) as { id: string };
    expect(body.id).toBe(sent[0]?.type === "StartGuide" ? sent[0].sessionId : "missing");
  });

  it("refuses input for a guide session that doesn't exist", async () => {
    expect((await post({ msg_id: "m1", type: "GuideInput", payload: { sessionId: "nope", input: {} } })).status).toBe(400);
  });
});

describe("creating agents", () => {
  it("CreateAgent carries the name, model and system prompt", async () => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "CreateAgent", payload: { runner: "laptop", name: " Poet ", model: "us.anthropic.claude-haiku-5-5", systemPrompt: "One haiku." } }, sent);
    expect(sent[0]).toEqual({ type: "CreateAgent", runner: "laptop", agent: { name: "Poet", model: "us.anthropic.claude-haiku-5-5", systemPrompt: "One haiku.", mcp: [], skills: [] } });
  });

  it("CreateAgent carries the picked MCP servers and skill copies", async () => {
    const sent: Msg[] = [];
    const files = [{ path: "SKILL.md", content: "---\nname: brief\ndescription: Briefs.\n---\nBe brief." }];
    await post({ msg_id: "m1", type: "CreateAgent", payload: { runner: "laptop", name: "R", model: "us.anthropic.claude-haiku-5-5", systemPrompt: "", mcp: ["fetch"], skills: [{ id: "brief", files }, { id: "kept" }] } }, sent);
    expect(sent[0]).toMatchObject({ agent: { mcp: ["fetch"], skills: [{ id: "brief", files }, { id: "kept" }] } });
  });

  it("SetMcpServer takes the server's entry as JSON text", async () => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "SetMcpServer", payload: { runner: "laptop", id: "fetch", entry: '{"command": "uvx", "args": ["mcp-server-fetch"]}' } }, sent);
    expect(sent[0]).toEqual({ type: "SetMcpServer", runner: "laptop", id: "fetch", entry: { command: "uvx", args: ["mcp-server-fetch"] } });
  });

  it("refuses a model that isn't offered", async () => {
    const body = (await (await post({ msg_id: "m1", type: "CreateAgent", payload: { runner: "laptop", name: "P", model: "nope", systemPrompt: "" } })).json()) as { error: string };
    expect(body.error).toContain("model must be one of");
  });

  it("EditAgent carries the agent and its new spec", async () => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "EditAgent", payload: { agent: "laptop/poet", name: "Poet", model: "us.anthropic.claude-haiku-5-5", systemPrompt: " Two haiku. " } }, sent);
    expect(sent[0]).toEqual({ type: "EditAgent", agent: "laptop/poet", spec: { name: "Poet", model: "us.anthropic.claude-haiku-5-5", systemPrompt: "Two haiku.", mcp: [], skills: [] } });
  });

  it("refuses an edit without a name", async () => {
    expect((await post({ msg_id: "m1", type: "EditAgent", payload: { agent: "laptop/poet", name: " ", model: "us.anthropic.claude-haiku-5-5", systemPrompt: "" } })).status).toBe(400);
  });

  it("lists the models UIs can offer", async () => {
    const body = (await (await api().request("/model", { headers: auth })).json()) as { model: { agentModels: { id: string }[] } };
    expect(body.model.agentModels.map((m) => m.id)).toContain("us.anthropic.claude-haiku-5-5");
  });
});

describe("runner transports", () => {
  it.each([
    [{ url: "http://h:9301/" }, { kind: "direct", url: "http://h:9301" }],
    [{ transport: { kind: "ssh", host: "box" } }, { kind: "ssh", host: "box", user: null, port: null, identityFile: null, remotePort: 9000 }],
    [
      { transport: { kind: "ssh", host: "10.0.0.5", user: "ec2-user", port: "2222", identityFile: "~/.ssh/fleet", remotePort: 9001 } },
      { kind: "ssh", host: "10.0.0.5", user: "ec2-user", port: 2222, identityFile: "~/.ssh/fleet", remotePort: 9001 },
    ],
    [
      { transport: { kind: "aws_ssm", region: "us-west-2", instanceId: "i-0abc", credentials: { kind: "profile", profile: "dev" } } },
      { kind: "aws_ssm", region: "us-west-2", instanceId: "i-0abc", remotePort: 9000, credentials: { kind: "profile", profile: "dev" } },
    ],
  ])("AddRunner accepts %j", async (payload, transport) => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "AddRunner", payload: { name: "home", token: "t", ...payload } }, sent);
    expect(sent[0]?.type === "AddRunner" && sent[0].transport).toEqual(transport);
  });

  it.each([
    [{ transport: { kind: "ssh", host: "-oProxyCommand=x" } }, "ssh transport needs a host"],
    [{ transport: { kind: "ssh", host: "box", user: "-l" } }, "ssh user may hold only"],
    [{ transport: { kind: "ssh", host: "box", port: 0 } }, "ssh ports must be 1-65535"],
    [{ transport: { kind: "ssh", host: "box", identityFile: "-F/etc/x" } }, "ssh identityFile must be a file path"],
    [{ transport: { kind: "aws_ssm", region: "us-west-2", instanceId: "box" } }, "aws_ssm transport needs an instanceId"],
    [{ transport: { kind: "telnet" } }, "transport kind must be"],
    [{ url: "h:9301" }, "url must start with"],
  ])("AddRunner refuses %j", async (payload, error) => {
    const body = (await (await post({ msg_id: "m1", type: "AddRunner", payload: { name: "home", token: "t", ...payload } })).json()) as { error: string };
    expect(body.error).toContain(error);
  });

  it("UpdateRunner with only a transport keeps the token", async () => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "UpdateRunner", payload: { name: "laptop", transport: { kind: "ssh", host: "box" } } }, sent);
    expect(sent[0]).toMatchObject({ type: "UpdateRunner", name: "laptop", transport: { kind: "ssh", host: "box" }, token: null });
  });

  it("UpdateRunner stores a new token in the vault and logs only its key", async () => {
    const sent: Msg[] = [];
    const vault = memoryVault();
    await post({ msg_id: "m1", type: "UpdateRunner", payload: { name: "laptop", token: "n3w" } }, sent, vault);
    const msg = sent[0];
    const key = msg?.type === "UpdateRunner" && msg.token?.kind === "vault" ? msg.token.key : "";
    expect([JSON.stringify(sent).includes("n3w"), msg?.type === "UpdateRunner" && msg.transport, await vault.get(key)]).toEqual([false, null, { ok: true, value: "n3w" }]);
  });

  it("UpdateRunner with nothing to change is refused", async () => {
    expect((await post({ msg_id: "m1", type: "UpdateRunner", payload: { name: "laptop" } })).status).toBe(400);
  });

  it.each([
    ["  Home laptop ", "Home laptop"],
    ["", null],
    ["laptop", null],
  ])("RenameRunner to %j logs label %j", async (label, logged) => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "RenameRunner", payload: { name: "laptop", label } }, sent);
    expect(sent[0]).toEqual({ type: "RenameRunner", name: "laptop", label: logged });
  });

  it("AddPluginAgent carries the runner, plugin and the fields as strings", async () => {
    const sent: Msg[] = [];
    await post({ msg_id: "m1", type: "AddPluginAgent", payload: { runner: "laptop", plugin: "docker", fields: { name: "Reports", image: "alpine", n: 3 } } }, sent);
    expect(sent[0]).toEqual({ type: "AddPluginAgent", runner: "laptop", plugin: "docker", fields: { name: "Reports", image: "alpine", n: "" } });
  });

  it("AddPluginAgent without fields is refused", async () => {
    expect((await post({ msg_id: "m1", type: "AddPluginAgent", payload: { runner: "laptop", plugin: "docker" } })).status).toBe(400);
  });

  it("RenameRunner refuses a name that's too long", async () => {
    expect((await post({ msg_id: "m1", type: "RenameRunner", payload: { name: "laptop", label: "x".repeat(41) } })).status).toBe(400);
  });
});

describe("transport facts for UIs", () => {
  it.each([
    ["http://127.0.0.1:9301", true],
    ["http://localhost:9301", true],
    ["http://homelab:9301", false],
  ])("a direct runner at %s is local: %s", (url, local) => {
    expect(transportFacts({ kind: "direct", url }).local).toBe(local);
  });

  it("an EC2 runner names its instance and is never local, though its tunnel is on loopback", () => {
    const t = { kind: "aws_ssm" as const, region: "us-west-2", instanceId: "i-1", remotePort: 9000, credentials: { kind: "default" as const } };
    expect(transportFacts(t)).toEqual({ transport: "aws_ssm", instanceId: "i-1", local: false });
  });
});
