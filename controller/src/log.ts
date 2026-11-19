import { Database } from "bun:sqlite";
import type { Msg } from "./types.ts";

export type LoggedMsg = { seq: number; msgId: string; at: number; msg: Msg };

export type MsgLog = {
  append: (msgId: string, msg: Msg) => number;
  has: (msgId: string) => boolean;
  all: () => LoggedMsg[];
};

export const openLog = (path: string): MsgLog => {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run(`CREATE TABLE IF NOT EXISTS msgs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`);
  const insert = db.prepare("INSERT INTO msgs (msg_id, at, body) VALUES (?, ?, ?) RETURNING seq");
  const exists = db.prepare("SELECT 1 FROM msgs WHERE msg_id = ?");
  const select = db.prepare("SELECT seq, msg_id, at, body FROM msgs ORDER BY seq");

  return {
    append: (msgId, msg) => (insert.get(msgId, Date.now(), JSON.stringify(msg)) as { seq: number }).seq,
    has: (msgId) => exists.get(msgId) !== null,
    all: () =>
      (select.all() as { seq: number; msg_id: string; at: number; body: string }[]).map((r) => ({
        seq: r.seq,
        msgId: r.msg_id,
        at: r.at,
        msg: JSON.parse(r.body) as Msg,
      })),
  };
};
