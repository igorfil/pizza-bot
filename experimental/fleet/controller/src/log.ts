import Database from "better-sqlite3";
import type { Msg } from "./types.js";

export type LoggedMsg = { seq: number; msgId: string; at: number; msg: Msg };

export type MsgLog = {
  append: (msgId: string, msg: Msg) => number;
  has: (msgId: string) => boolean;
  all: () => LoggedMsg[];
};

type Row = { seq: number; msg_id: string; at: number; body: string };

export const openLog = (path: string): MsgLog => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS msgs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`);
  const insert = db.prepare<[string, number, string], { seq: number }>(
    "INSERT INTO msgs (msg_id, at, body) VALUES (?, ?, ?) RETURNING seq",
  );
  const exists = db.prepare<[string], { found: 1 }>("SELECT 1 AS found FROM msgs WHERE msg_id = ?");
  const select = db.prepare<[], Row>("SELECT seq, msg_id, at, body FROM msgs ORDER BY seq");

  return {
    append: (msgId, msg) => insert.get(msgId, Date.now(), JSON.stringify(msg))!.seq,
    has: (msgId) => exists.get(msgId) !== undefined,
    all: () =>
      select.all().map((r) => ({
        seq: r.seq,
        msgId: r.msg_id,
        at: r.at,
        msg: JSON.parse(r.body) as Msg,
      })),
  };
};
