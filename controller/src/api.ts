import { INTENT_TYPES, type IntentMsg, type Model } from "./types.ts";
import type { Runtime } from "./runtime.ts";

const KEEPALIVE_MS = 15_000;

/** Runner tokens never leave the Controller. */
export const publicModel = (model: Model) => ({
  ...model,
  runners: Object.fromEntries(Object.entries(model.runners).map(([k, { token: _t, ...r }]) => [k, r])),
});

type Envelope = { msg_id?: unknown; type?: unknown; payload?: unknown };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Ids are minted here, not by UIs, so `update` stays pure and replayable. */
export const toIntent = (type: string, p: Record<string, unknown>): IntentMsg | string => {
  switch (type) {
    case "AddRunner":
      return str(p.name) && str(p.url) && str(p.token)
        ? { type, name: p.name, url: p.url, token: p.token }
        : "AddRunner needs name, url, token";
    case "RemoveRunner":
      return str(p.name) ? { type, name: p.name } : "RemoveRunner needs name";
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
  intent.type === "CreateTask" ? intent.taskId : intent.type === "CreateChat" ? intent.chatId : null;

const json = (body: unknown, status = 200) => Response.json(body, { status });

const postMsg = async (req: Request, runtime: Runtime): Promise<Response> => {
  const body = (await req.json().catch(() => null)) as Envelope | null;
  if (!body || !str(body.msg_id) || !str(body.type)) return json({ error: "need msg_id and type" }, 400);
  if (!INTENT_TYPES.has(body.type)) return json({ error: `${body.type} is not an intent` }, 400);
  const intent = toIntent(body.type, (body.payload ?? {}) as Record<string, unknown>);
  if (typeof intent === "string") return json({ error: intent }, 400);
  const { version, duplicate } = runtime.send(body.msg_id, intent);
  return json({ accepted_at_version: version, duplicate, id: duplicate ? null : createdId(intent) }, duplicate ? 200 : 202);
};

const sseFrame = (version: number, model: Model) =>
  `id: ${version}\ndata: ${JSON.stringify({ version, model: publicModel(model) })}\n\n`;

const streamModel = (req: Request, runtime: Runtime): Response => {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => controller.enqueue(enc.encode(text));
      const { version, model } = runtime.snapshot();
      push(sseFrame(version, model));
      const off = runtime.onChange((v, m) => push(sseFrame(v, m)));
      const keepalive = setInterval(() => push(": keepalive\n\n"), KEEPALIVE_MS);
      cleanup = () => {
        off();
        clearInterval(keepalive);
      };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel: () => cleanup(),
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
};

const route = (req: Request, runtime: Runtime, token: string): Response | Promise<Response> => {
  if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const { pathname } = new URL(req.url);
  if (req.method === "POST" && pathname === "/msg") return postMsg(req, runtime);
  if (req.method === "GET" && pathname === "/model") {
    const { version, model } = runtime.snapshot();
    return json({ version, model: publicModel(model) });
  }
  if (req.method === "GET" && pathname === "/model/stream") return streamModel(req, runtime);
  return json({ error: "not found" }, 404);
};

const corsHeaders = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  vary: "origin",
});

const withCors = async (res: Response | Promise<Response>, origin: string): Promise<Response> => {
  const r = await res;
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => r.headers.set(k, v));
  return r;
};

export const serveApi = (runtime: Runtime, opts: { port: number; token: string; allowedOrigins: ReadonlySet<string> }) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 0,
    fetch: (req) => {
      const origin = req.headers.get("origin");
      if (origin === null) return route(req, runtime, opts.token);
      // Browsers always send Origin; only explicitly allowed UIs may drive the fleet via localhost.
      if (!opts.allowedOrigins.has(origin)) return json({ error: "browser origin not allowed" }, 403);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
      return withCors(route(req, runtime, opts.token), origin);
    },
  });
