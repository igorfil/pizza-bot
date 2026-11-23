import { describe, expect, it } from "vitest";
import { createApi } from "./api.js";
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
