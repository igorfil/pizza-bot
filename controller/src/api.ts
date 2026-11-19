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
      return str(p.runner) && typeof p.prompt === "string"
        ? { type, taskId: crypto.randomUUID(), runner: p.runner, prompt: p.prompt }
        : "CreateTask needs runner, prompt";
    case "CancelTask":
      return str(p.taskId) ? { type, taskId: p.taskId } : "CancelTask needs taskId";
    default:
      return `unknown intent ${type}`;
  }
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

const postMsg = async (req: Request, runtime: Runtime): Promise<Response> => {
  const body = (await req.json().catch(() => null)) as Envelope | null;
  if (!body || !str(body.msg_id) || !str(body.type)) return json({ error: "need msg_id and type" }, 400);
  if (!INTENT_TYPES.has(body.type)) return json({ error: `${body.type} is not an intent` }, 400);
  const intent = toIntent(body.type, (body.payload ?? {}) as Record<string, unknown>);
  if (typeof intent === "string") return json({ error: intent }, 400);
  const { version, duplicate } = runtime.send(body.msg_id, intent);
  return json({ accepted_at_version: version, duplicate }, duplicate ? 200 : 202);
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

export const serveApi = (runtime: Runtime, opts: { port: number; token: string }) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 0,
    fetch: (req) => {
      // Browsers always send Origin; refusing it stops random websites driving the fleet via localhost.
      if (req.headers.get("origin")) return json({ error: "browser origins not allowed" }, 403);
      if (req.headers.get("authorization") !== `Bearer ${opts.token}`) return json({ error: "unauthorized" }, 401);
      const { pathname } = new URL(req.url);
      if (req.method === "POST" && pathname === "/msg") return postMsg(req, runtime);
      if (req.method === "GET" && pathname === "/model") {
        const { version, model } = runtime.snapshot();
        return json({ version, model: publicModel(model) });
      }
      if (req.method === "GET" && pathname === "/model/stream") return streamModel(req, runtime);
      return json({ error: "not found" }, 404);
    },
  });
