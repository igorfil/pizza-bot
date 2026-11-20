#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serveApi } from "./api.js";
import { openLog } from "./log.js";
import { startRuntime } from "./runtime.js";

const home = process.env.FLEET_HOME ?? join(homedir(), ".agent-fleet");
const port = Number(process.env.FLEET_PORT ?? 7700);
const allowedOrigins = new Set(
  (process.env.FLEET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
);

const loadToken = (path: string): string => {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = crypto.randomUUID();
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
};

mkdirSync(home, { recursive: true });
const token = loadToken(join(home, "token"));
const runtime = startRuntime(openLog(join(home, "controller.db")));
serveApi(runtime, { port, token, allowedOrigins });
console.log(`controller listening on http://127.0.0.1:${port} (home ${home}, browser origins: ${[...allowedOrigins].join(", ") || "none"})`);
