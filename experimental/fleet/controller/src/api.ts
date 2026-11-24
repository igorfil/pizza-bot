import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AGENT_MODELS } from "./agent-models.js";
import { INTENT_TYPES, type GuideInput, type IntentMsg, type Model, type NewAgentSpec, type TransportSpec } from "./types.js";
import type { Runtime } from "./runtime.js";
import type { SecretStore } from "./vault.js";

const KEEPALIVE_MS = 15_000;

const LOOPBACK = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/;

/** What a UI may know about a runner's transport: its kind, the EC2 instance, and whether it is this machine. */
export const transportFacts = (t: TransportSpec) => ({
  transport: t.kind,
  instanceId: t.kind === "aws_ssm" ? t.instanceId : null,
  local: t.kind === "direct" && LOOPBACK.test(t.url),
});

/** Runner tokens and guide internals never leave the Controller. */
export const publicModel = (model: Model) => ({
  ...model,
  agentModels: AGENT_MODELS,
  runners: Object.fromEntries(Object.entries(model.runners).map(([k, { token: _t, transport, ...r }]) => [k, { ...r, ...transportFacts(transport) }])),
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

const HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const INSTANCE_ID = /^i-[0-9a-f]+$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const DEFAULT_RUNNER_PORT = 9000;

const portOf = (v: unknown): number | null => {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65_536 ? n : null;
};

/** Optional fields may be absent or empty; anything given must be valid. */
const optional = <T>(v: unknown, parse: (v: unknown) => T | null): T | null | undefined =>
  v === undefined || v === null || v === "" ? null : (parse(v) ?? undefined);

const matching = (re: RegExp) => (v: unknown): string | null => (typeof v === "string" && re.test(v) ? v : null);

const pathOf = (v: unknown): string | null => (typeof v === "string" && !v.startsWith("-") && !/[\0\n]/.test(v) ? v : null);

const sshOf = (t: Record<string, unknown>): TransportSpec | string => {
  const user = optional(t.user, matching(HOST));
  const port = optional(t.port, portOf);
  const identityFile = optional(t.identityFile, pathOf);
  const remotePort = optional(t.remotePort, portOf);
  if (!matching(HOST)(t.host)) return "ssh transport needs a host (a name or address, or a ~/.ssh/config alias)";
  if (user === undefined) return "ssh user may hold only letters, digits, '.', '_' and '-'";
  if (port === undefined || remotePort === undefined) return "ssh ports must be 1-65535";
  if (identityFile === undefined) return "ssh identityFile must be a file path";
  return { kind: "ssh", host: t.host as string, user, port, identityFile, remotePort: remotePort ?? DEFAULT_RUNNER_PORT };
};

/** Only credentials that hold no secret: access keys go through the AWS guide, which vaults them. */
const awsSsmOf = (t: Record<string, unknown>): TransportSpec | string => {
  const remotePort = optional(t.remotePort, portOf);
  const creds = (t.credentials ?? { kind: "default" }) as Record<string, unknown>;
  const credentials = creds.kind === "default" ? ({ kind: "default" } as const) : creds.kind === "profile" && str(creds.profile) ? ({ kind: "profile", profile: creds.profile } as const) : null;
  if (!matching(REGION)(t.region)) return "aws_ssm transport needs a region like us-west-2";
  if (!matching(INSTANCE_ID)(t.instanceId)) return "aws_ssm transport needs an instanceId like i-0abc";
  if (remotePort === undefined) return "aws_ssm remotePort must be 1-65535";
  if (!credentials) return "aws_ssm credentials must be {kind: default} or {kind: profile, profile}";
  return { kind: "aws_ssm", region: t.region as string, instanceId: t.instanceId as string, remotePort: remotePort ?? DEFAULT_RUNNER_PORT, credentials };
};

/** `url` is shorthand for a direct transport; null when neither is given. */
export const transportOf = (p: Record<string, unknown>): TransportSpec | string | null => {
  if (p.transport === undefined || p.transport === null) {
    if (p.url === undefined) return null;
    return typeof p.url === "string" && /^https?:\/\/[^\s/]+/.test(p.url) ? { kind: "direct", url: p.url.replace(/\/+$/, "") } : "url must start with http:// or https://";
  }
  const t = p.transport as Record<string, unknown>;
  switch (t.kind) {
    case "direct":
      return transportOf({ url: t.url ?? "" });
    case "ssh":
      return sshOf(t);
    case "aws_ssm":
      return awsSsmOf(t);
    default:
      return "transport kind must be direct, ssh or aws_ssm";
  }
};

const agentSpecOf = (type: string, p: Record<string, unknown>): NewAgentSpec | string => {
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const model = typeof p.model === "string" ? p.model : "";
  const systemPrompt = typeof p.systemPrompt === "string" ? p.systemPrompt.trim() : "";
  if (!name) return `${type} needs name, model, systemPrompt`;
  if (name.length > 60) return "the agent name must be at most 60 characters";
  if (!AGENT_MODELS.some((m) => m.id === model)) return `model must be one of ${AGENT_MODELS.map((m) => m.id).join(", ")}`;
  if (systemPrompt.length > 20_000) return "the system prompt must be at most 20000 characters";
  return { name, model, systemPrompt };
};

/** Ids are minted here, not by UIs, so `update` stays pure and replayable. */
export const toIntent = async (type: string, p: Record<string, unknown>, ctx: IntentContext): Promise<IntentMsg | string> => {
  switch (type) {
    case "AddRunner": {
      if (!(str(p.name) && str(p.token))) return "AddRunner needs name, token, and url or transport";
      const transport = transportOf(p);
      if (typeof transport === "string") return transport;
      if (!transport) return "AddRunner needs url or transport";
      const key = `runner/${p.name}/${crypto.randomUUID()}`;
      const error = await storeSecret(ctx.vault, key, p.token);
      return error ?? { type, name: p.name, transport, token: { kind: "vault", key }, origin: null };
    }
    case "UpdateRunner": {
      if (!str(p.name)) return "UpdateRunner needs name";
      const transport = transportOf(p);
      if (typeof transport === "string") return transport;
      if (!transport && !str(p.token)) return "UpdateRunner needs url, transport or token";
      const key = str(p.token) ? `runner/${p.name}/${crypto.randomUUID()}` : null;
      const error = key && str(p.token) ? await storeSecret(ctx.vault, key, p.token) : null;
      return error ?? { type, name: p.name, transport, token: key ? { kind: "vault", key } : null };
    }
    case "AddAgents":
      return str(p.runner) && Array.isArray(p.agents) && p.agents.length > 0 && p.agents.every(str)
        ? { type, runner: p.runner, agents: p.agents as string[] }
        : "AddAgents needs runner and agents (a non-empty list of agent ids)";
    case "CreateAgent": {
      if (!str(p.runner)) return "CreateAgent needs runner, name, model, systemPrompt";
      const agent = agentSpecOf(type, p);
      return typeof agent === "string" ? agent : { type, runner: p.runner, agent };
    }
    case "EditAgent": {
      if (!str(p.agent)) return "EditAgent needs agent (<runner>/<id>), name, model, systemPrompt";
      const spec = agentSpecOf(type, p);
      return typeof spec === "string" ? spec : { type, agent: p.agent, spec };
    }
    case "DeleteAgent":
      return str(p.agent) ? { type, agent: p.agent } : "DeleteAgent needs agent (<runner>/<id>)";
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
