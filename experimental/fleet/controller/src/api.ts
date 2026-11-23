import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { INTENT_TYPES, type GuideInput, type IntentMsg, type Model } from "./types.js";
import type { Runtime } from "./runtime.js";
import type { SecretStore } from "./vault.js";

const KEEPALIVE_MS = 15_000;

/** Runner tokens and guide internals never leave the Controller. */
export const publicModel = (model: Model) => ({
  ...model,
  runners: Object.fromEntries(Object.entries(model.runners).map(([k, { token: _t, transport, ...r }]) => [k, { ...r, transport: transport.kind }])),
  guideSessions: Object.fromEntries(Object.entries(model.guideSessions).map(([k, { state: _s, secretKeys: _k, ...g }]) => [k, g])),
});

type Envelope = { msg_id?: unknown; type?: unknown; payload?: unknown };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

type IntentContext = { vault: SecretStore; model: Model };

/** Secrets go to the vault here, before the Msg is logged; the Msg carries only the key. */
const storeSecret = async (vault: SecretStore, key: string, value: string): Promise<string | null> => {
  const stored = await vault.set(key, value);
  return stored.ok ? null : stored.error;
};

const guideInput = async (sessionId: string, raw: Record<string, unknown>, ctx: IntentContext): Promise<IntentMsg | string> => {
  const session = ctx.model.guideSessions[sessionId];
  if (!session) return `no guide session ${sessionId}`;
  const secretIds = new Set(session.view.fields.filter((f) => f.kind === "secret").map((f) => f.id));
  const entries = Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string");
  const input: GuideInput = {};
  for (const [id, value] of entries) {
    if (!secretIds.has(id) || value === "") {
      input[id] = value;
      continue;
    }
    const key = `guide/${sessionId}/${id}/${crypto.randomUUID()}`;
    const error = await storeSecret(ctx.vault, key, value);
    if (error) return error;
    input[id] = key;
  }
  return { type: "GuideInput", sessionId, input };
};

/** Ids are minted here, not by UIs, so `update` stays pure and replayable. */
export const toIntent = async (type: string, p: Record<string, unknown>, ctx: IntentContext): Promise<IntentMsg | string> => {
  switch (type) {
    case "AddRunner": {
      if (!(str(p.name) && str(p.url) && str(p.token))) return "AddRunner needs name, url, token";
      const key = `runner/${p.name}/${crypto.randomUUID()}`;
      const error = await storeSecret(ctx.vault, key, p.token);
      return error ?? { type, name: p.name, transport: { kind: "direct", url: p.url.replace(/\/+$/, "") }, token: { kind: "vault", key }, origin: null };
    }
    case "RemoveRunner":
      return str(p.name) ? { type, name: p.name, teardown: p.teardown === true || p.teardown === "true" } : "RemoveRunner needs name";
    case "StartGuide":
      return str(p.guide) ? { type, sessionId: crypto.randomUUID(), guide: p.guide } : "StartGuide needs guide";
    case "GuideInput":
      return str(p.sessionId) ? guideInput(p.sessionId, (p.input ?? {}) as Record<string, unknown>, ctx) : "GuideInput needs sessionId, input";
    case "GuideRetry":
      return str(p.sessionId) ? { type, sessionId: p.sessionId } : "GuideRetry needs sessionId";
    case "CancelGuide":
      return str(p.sessionId) ? { type, sessionId: p.sessionId } : "CancelGuide needs sessionId";
    case "CreateTask":
      return str(p.agent) && typeof p.prompt === "string"
        ? { type, taskId: crypto.randomUUID(), agent: p.agent, prompt: p.prompt }
        : "CreateTask needs agent (<runner>/<id>), prompt";
    case "CancelTask":
      return str(p.taskId) ? { type, taskId: p.taskId } : "CancelTask needs taskId";
    case "AckInbox":
      return str(p.taskId) ? { type, taskId: p.taskId } : "AckInbox needs taskId";
    case "AckAllInbox":
      return { type };
    case "CreateChat":
      return {
        type,
        chatId: crypto.randomUUID(),
        fromTaskId: str(p.fromTaskId) ? p.fromTaskId : null,
        text: typeof p.text === "string" ? p.text : "",
      };
    case "SendChatMessage":
      return str(p.chatId) && str(p.text) ? { type, chatId: p.chatId, text: p.text } : "SendChatMessage needs chatId, text";
    case "SetSchedule":
      return str(p.agent)
        ? { type, agent: p.agent, at: str(p.at) ? p.at : null, prompt: typeof p.prompt === "string" ? p.prompt : "" }
        : "SetSchedule needs agent (and at=HH:MM, or empty to turn it off)";
    default:
      return `unknown intent ${type}`;
  }
};

/** Lets a UI select what it just created (e.g. open the new chat). */
const createdId = (intent: IntentMsg): string | null =>
  intent.type === "CreateTask" ? intent.taskId : intent.type === "CreateChat" ? intent.chatId : intent.type === "StartGuide" ? intent.sessionId : null;

const corsHeaders = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  vary: "origin",
});

export type ApiOptions = { token: string; allowedOrigins: ReadonlySet<string>; vault: SecretStore };

/** The HTTP API as a Hono app, separate from the server so tests can call `app.request`. */
export const createApi = (runtime: Runtime, opts: ApiOptions): Hono => {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      // Browsers always send Origin; only explicitly allowed UIs may drive the fleet via localhost.
      if (!opts.allowedOrigins.has(origin)) return c.json({ error: "browser origin not allowed" }, 403);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => c.header(k, v));
      if (c.req.method === "OPTIONS") return c.body(null, 204);
    }
    if (c.req.header("authorization") !== `Bearer ${opts.token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.post("/msg", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Envelope | null;
    if (!body || !str(body.msg_id) || !str(body.type)) return c.json({ error: "need msg_id and type" }, 400);
    if (!INTENT_TYPES.has(body.type)) return c.json({ error: `${body.type} is not an intent` }, 400);
    const intent = await toIntent(body.type, (body.payload ?? {}) as Record<string, unknown>, { vault: opts.vault, model: runtime.snapshot().model });
    if (typeof intent === "string") return c.json({ error: intent }, 400);
    const { version, duplicate } = runtime.send(body.msg_id, intent);
    return c.json({ accepted_at_version: version, duplicate, id: duplicate ? null : createdId(intent) }, duplicate ? 200 : 202);
  });

  app.get("/model", (c) => {
    const { version, model } = runtime.snapshot();
    return c.json({ version, model: publicModel(model) });
  });

  app.get("/model/stream", (c) =>
    streamSSE(c, async (stream) => {
      const frame = (version: number, model: Model) =>
        stream.writeSSE({ id: String(version), data: JSON.stringify({ version, model: publicModel(model) }) });
      const { version, model } = runtime.snapshot();
      await frame(version, model);
      const off = runtime.onChange((v, m) => void frame(v, m));
      const keepalive = setInterval(() => void stream.write(": keepalive\n\n"), KEEPALIVE_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      off();
      clearInterval(keepalive);
    }),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
};

export const serveApi = (runtime: Runtime, opts: ApiOptions & { port: number }) =>
  serve({ fetch: createApi(runtime, opts).fetch, hostname: "127.0.0.1", port: opts.port });
