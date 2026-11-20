// Dev launcher for both backends side by side: the pizza-bot api-server (:8080), the experimental fleet
// (Controller :7700, laptop runner :9301, SSH tunnel to the EC2 runner :9471) and the web app (:5173).
// One process dying takes the group down, like scripts/dev.mjs.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveNpmCli } from "./npm-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fleet = path.join(root, "experimental", "fleet");

const WEB_PORT = Number(process.env.PIZZA_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.PORT ?? 8080);
// Shared with the Fleet page's default connection (apps/web/src/components/fleet/fleet-client.ts).
const FLEET_DEV_TOKEN = "fleet-dev-token";
const FLEET_HOME = process.env.FLEET_HOME ?? path.join(homedir(), ".agent-fleet");
// Empty string disables the tunnel (e.g. no AWS access).
const EC2_INSTANCE = process.env.FLEET_EC2_INSTANCE ?? "<instance-id>";
const webOrigins = [`http://localhost:${WEB_PORT}`, "http://localhost:5273"].join(",");

const viteBin = path.join(
  path.dirname(createRequire(path.join(root, "apps/web/package.json")).resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const runnerBin = path.join(fleet, "runner", "target", "debug", "fleet-runner");
const toolboxBin = path.join(homedir(), ".toolbox", "bin");

mkdirSync(FLEET_HOME, { recursive: true });
writeFileSync(path.join(FLEET_HOME, "token"), FLEET_DEV_TOKEN, { mode: 0o600 });
chmodSync(path.join(FLEET_HOME, "token"), 0o600);

if (!existsSync(runnerBin)) {
  const homeCargo = path.join(homedir(), ".cargo", "bin", "cargo");
  const cargo = process.env.CARGO ?? (existsSync(homeCargo) ? homeCargo : "cargo");
  console.log("[dev-both] building the fleet runner (cargo build)…");
  const built = spawnSync(cargo, ["build"], { cwd: path.join(fleet, "runner"), stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

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
  PIZZA_ALLOWED_ORIGINS: webOrigins,
});

launch("fleet-controller", process.execPath, [resolveNpmCli(), "run", "dev", "-w", "@pizza-bot/fleet-controller"], root, {
  FLEET_HOME,
  FLEET_ALLOWED_ORIGINS: webOrigins,
});

launch("fleet-runner", runnerBin, [], fleet, {
  // morningbrief reads Outlook through aws-outlook-mcp, which aim/toolbox installs into ~/.toolbox/bin.
  PATH: `${toolboxBin}${path.delimiter}${process.env.PATH ?? ""}`,
  RUNNER_NAME: "laptop",
  RUNNER_TOKEN: "localtoken",
  RUNNER_LOCATION: "this laptop",
  RUNNER_AGENTS_DIR: "agents",
  RUNNER_AGENTS: "sysreport,morningbrief,slow",
  RUNNER_DB: path.join(FLEET_HOME, "laptop-runner.db"),
  RUNNER_BIND: "127.0.0.1:9301",
  AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
});

if (EC2_INSTANCE) launch("fleet-tunnel", "bash", [path.join(fleet, "deploy", "tunnel.sh"), EC2_INSTANCE], fleet);

launch("web", process.execPath, [viteBin, "--port", String(WEB_PORT), "--strictPort"], path.join(root, "apps/web"), {
  PIZZA_API_TARGET: `http://localhost:${API_PORT}`,
});

console.log(`[dev-both] web          → http://localhost:${WEB_PORT}  (Fleet page: left rail)`);
console.log(`[dev-both] api-server   → http://localhost:${API_PORT}`);
console.log(`[dev-both] fleet        → http://127.0.0.1:7700  token=${FLEET_DEV_TOKEN}`);
