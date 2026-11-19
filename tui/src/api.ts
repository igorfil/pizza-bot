import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppModel } from "./model.ts";

const home = process.env.FLEET_HOME ?? join(homedir(), ".agent-fleet");
const base = `http://127.0.0.1:${process.env.FLEET_PORT ?? 7700}`;
const headers = { authorization: `Bearer ${readFileSync(join(home, "token"), "utf8").trim()}` };

export type SendResult = { ok: true } | { ok: false; error: string };

export const sendIntent = async (type: string, payload: Record<string, string>): Promise<SendResult> => {
  try {
    const res = await fetch(`${base}/msg`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ msg_id: crypto.randomUUID(), type, payload }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const frameData = (frame: string) =>
  frame
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .join("");

/** Follows the Model stream forever, reconnecting after drops. */
export const followModel = async (onModel: (model: AppModel) => void, onConnected: (up: boolean) => void) => {
  for (;;) {
    try {
      const res = await fetch(`${base}/model/stream`, { headers });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onConnected(true);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        const frames = (buffer + decoder.decode(chunk, { stream: true })).split("\n\n");
        buffer = frames.pop() ?? "";
        frames
          .map(frameData)
          .filter((d) => d.length > 0)
          .forEach((d) => onModel((JSON.parse(d) as { model: AppModel }).model));
      }
    } catch {
      // reconnect below
    }
    onConnected(false);
    await Bun.sleep(1000);
  }
};
