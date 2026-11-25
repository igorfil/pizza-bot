import { createParser } from "eventsource-parser";
import type { FleetModel } from "./fleet-types.js";

export interface FleetConnection {
  url: string;
  token: string;
}

const STORAGE_KEY = "pizza.fleet.connection";
export const DEFAULT_FLEET_URL = "http://127.0.0.1:7700";
// Matches scripts/fleet-dev.mjs so a local test setup connects with no configuration.
export const DEV_FLEET_CONNECTION: FleetConnection = { url: DEFAULT_FLEET_URL, token: "fleet-dev-token" };

export function loadFleetConnection(): FleetConnection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEV_FLEET_CONNECTION;
    const parsed = JSON.parse(raw) as Partial<FleetConnection>;
    return typeof parsed.url === "string" && typeof parsed.token === "string"
      ? { url: parsed.url, token: parsed.token }
      : DEV_FLEET_CONNECTION;
  } catch {
    return DEV_FLEET_CONNECTION;
  }
}

export function saveFleetConnection(connection: FleetConnection | null): void {
  if (connection) localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  else localStorage.removeItem(STORAGE_KEY);
}

export class FleetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const base = (c: FleetConnection) => c.url.replace(/\/+$/, "");
const auth = (c: FleetConnection) => ({ authorization: `Bearer ${c.token}` });

const failure = async (res: Response): Promise<FleetError> => {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new FleetError(body.error ?? `HTTP ${res.status}`, res.status);
};

export type FleetIntent =
  | "AddRunner"
  | "RemoveRunner"
  | "RenameRunner"
  | "AddAgents"
  | "EnableAgent"
  | "DisableAgent"
  | "CreateAgent"
  | "AddPluginAgent"
  | "SetMcpServer"
  | "RemoveMcpServer"
  | "DeleteAgent"
  | "EditAgent"
  | "CreateTask"
  | "CancelTask"
  | "AckInbox"
  | "AckAllInbox"
  | "CreateChat"
  | "SendChatMessage"
  | "SetSchedule"
  | "StartGuide"
  | "GuideInput"
  | "GuideRetry"
  | "CancelGuide";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type FleetPayload = Record<string, Json>;

/**
 * @returns the id the Controller minted (new task or chat), if any
 * @throws FleetError when the Controller rejects the intent or is unreachable
 */
export async function sendFleetIntent(
  connection: FleetConnection,
  type: FleetIntent,
  payload: FleetPayload,
): Promise<string | null> {
  const res = await fetch(`${base(connection)}/msg`, {
    method: "POST",
    headers: { ...auth(connection), "content-type": "application/json" },
    body: JSON.stringify({ msg_id: crypto.randomUUID(), type, payload }),
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof body.id === "string" ? body.id : null;
}

/**
 * Streams full Model snapshots until `signal` aborts or the stream ends.
 * EventSource can't send an Authorization header, so this reads SSE over fetch.
 * @throws FleetError on non-2xx (e.g. 401 bad token, 403 origin not allowed)
 */
export async function streamFleetModel(
  connection: FleetConnection,
  signal: AbortSignal,
  onModel: (model: FleetModel) => void,
): Promise<void> {
  const res = await fetch(`${base(connection)}/model/stream`, { headers: auth(connection), signal });
  if (!res.ok || !res.body) throw await failure(res);
  const parser = createParser({
    onEvent: (event) => onModel((JSON.parse(event.data) as { model: FleetModel }).model),
  });
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}
