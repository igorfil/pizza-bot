#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveApi } from "./api.js";
import { nameProblem } from "./guides/guide.js";
import { loadGuidePlugins } from "./guides/load.js";
import type { GuidePlugin, PluginHost } from "./guides/plugin.js";
import { builtInPlugins, guidesOf } from "./guides/registry.js";
import { openLog } from "./log.js";
import { startRuntime } from "./runtime.js";
import { transportFor } from "./transport.js";
import type { TransportSpec } from "./types.js";
import { vaultFromEnv } from "./vault.js";

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
const vault = vaultFromEnv();
const guidesDir = process.env.FLEET_RUNNER_GUIDES_DIR ?? fileURLToPath(new URL("../../runner-guides", import.meta.url));

let plugins: GuidePlugin[] = [];
const transports = (spec: TransportSpec) =>
  transportFor(spec, { vault, plugins: (t) => plugins.find((p) => p.id === t.plugin)?.transport?.(t) ?? null });
const host: PluginHost = {
  vault,
  transports,
  localBuildDir: fileURLToPath(new URL("../../runner/target-linux/dist", import.meta.url)),
  nameProblem,
};
const builtIn = builtInPlugins(host);
const loaded = await loadGuidePlugins(guidesDir, host, builtIn);
loaded.warnings.forEach((w) => console.warn(w));
plugins = [...builtIn, ...loaded.plugins];
if (loaded.plugins.length > 0) console.log(`runner-guide plugins from ${guidesDir}: ${loaded.plugins.map((p) => p.id).join(", ")}`);

const runtime = startRuntime(openLog(join(home, "controller.db")), { vault, transports, guides: guidesOf(plugins) });
serveApi(runtime, { port, token, allowedOrigins, vault });
console.log(`controller listening on http://127.0.0.1:${port} (home ${home}, browser origins: ${[...allowedOrigins].join(", ") || "none"})`);
