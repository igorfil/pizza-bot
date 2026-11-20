// Browser-only variant of `npm run dev`: the pizza-bot api-server (:8080) as a plain process instead
// of Electron's sidecar, the experimental fleet (scripts/fleet-dev.mjs) and Vite (:5173).
// One process dying takes the group down, like scripts/dev.mjs.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveNpmCli } from "./npm-cli.mjs";
import { FLEET_DEV_TOKEN, fleetProcesses, registerLocalRunner } from "./fleet-dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WEB_PORT = Number(process.env.PIZZA_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.PORT ?? 8080);
const webOrigins = [`http://localhost:${WEB_PORT}`, "http://localhost:5273"];

const viteBin = path.join(
  path.dirname(createRequire(path.join(root, "apps/web/package.json")).resolve("vite/package.json")),
  "bin",
  "vite.js",
);
// Before any child starts: the first run may build the fleet runner.
const fleet = fleetProcesses({ root, webOrigins });

const children = [];
let shuttingDown = false;

function launch(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev-both] ${name} exited (code=${code} signal=${signal}); stopping the rest`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 5_000).unref();
  Promise.all(
    children.map((c) => (c.exitCode === null ? new Promise((r) => c.once("exit", r)) : Promise.resolve())),
  ).then(() => process.exit(exitCode));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launch("api-server", process.execPath, [resolveNpmCli(), "run", "dev", "-w", "@pizza-bot/api-server"], root, {
  PORT: String(API_PORT),
  PIZZA_DATA_ROOT: process.env.PIZZA_DATA_ROOT ?? path.join(tmpdir(), "pizza-bot-dev-both"),
  PIZZA_ALLOWED_ORIGINS: webOrigins.join(","),
});

if ("skip" in fleet) console.warn(`[dev-both] fleet skipped: ${fleet.skip}`);
else {
  for (const p of fleet.processes) launch(p.name, p.command, p.args, p.cwd, p.env);
  void registerLocalRunner();
}

launch("web", process.execPath, [viteBin, "--port", String(WEB_PORT), "--strictPort"], path.join(root, "apps/web"), {
  PIZZA_API_TARGET: `http://localhost:${API_PORT}`,
});

console.log(`[dev-both] web          → http://localhost:${WEB_PORT}  (Fleet page: left rail)`);
console.log(`[dev-both] api-server   → http://localhost:${API_PORT}`);
console.log(`[dev-both] fleet        → http://127.0.0.1:7700  token=${FLEET_DEV_TOKEN}`);
