// The experimental fleet's dev processes (Controller, laptop runner), shared by
// `npm run dev` and `npm run dev:both`. Set PIZZA_FLEET=0 to start pizza-bot without the fleet.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveNpmCli } from "./npm-cli.mjs";

// Shared with the Fleet page's default connection (apps/web/src/components/fleet/fleet-client.ts).
export const FLEET_DEV_TOKEN = "fleet-dev-token";
const CONTROLLER_URL = "http://127.0.0.1:7700";
const LOCAL_RUNNER = { name: "laptop", url: "http://127.0.0.1:9301", token: "localtoken" };

const cargoCommand = () => {
  const homeCargo = path.join(homedir(), ".cargo", "bin", "cargo");
  return process.env.CARGO ?? (existsSync(homeCargo) ? homeCargo : "cargo");
};

/**
 * Prepares the fleet (dev token, runner build) and returns the processes to launch, or a reason
 * to skip it. A missing Rust toolchain skips the fleet instead of failing pizza-bot's own dev loop.
 * @returns {{ processes: { name: string, command: string, args: string[], cwd: string, env: Record<string, string> }[] } | { skip: string }}
 */
export function fleetProcesses({ root, webOrigins }) {
  if (process.env.PIZZA_FLEET === "0") return { skip: "PIZZA_FLEET=0" };

  const fleet = path.join(root, "experimental", "fleet");
  const home = process.env.FLEET_HOME ?? path.join(homedir(), ".agent-fleet");
  const runnerBin = path.join(fleet, "runner", "target", "debug", "fleet-runner");

  if (!existsSync(runnerBin)) {
    console.log("[fleet] building the runner (cargo build, first run only)…");
    const built = spawnSync(cargoCommand(), ["build"], { cwd: path.join(fleet, "runner"), stdio: "inherit" });
    if (built.error || built.status !== 0) {
      return { skip: `the runner didn't build (${built.error?.message ?? `cargo exited ${built.status}`}); install Rust or set PIZZA_FLEET=0` };
    }
  }

  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "token"), FLEET_DEV_TOKEN, { mode: 0o600 });
  chmodSync(path.join(home, "token"), 0o600);

  const processes = [
    {
      name: "fleet-controller",
      command: process.execPath,
      args: [resolveNpmCli(), "run", "dev", "-w", "@pizza-bot/fleet-controller"],
      cwd: root,
      env: { FLEET_HOME: home, FLEET_ALLOWED_ORIGINS: webOrigins.join(",") },
    },
    {
      name: "fleet-runner",
      command: runnerBin,
      args: [],
      cwd: fleet,
      env: {
        // morningbrief reads Outlook through aws-outlook-mcp, which aim/toolbox installs into ~/.toolbox/bin.
        PATH: `${path.join(homedir(), ".toolbox", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_NAME: LOCAL_RUNNER.name,
        RUNNER_TOKEN: LOCAL_RUNNER.token,
        RUNNER_LOCATION: "this laptop",
        RUNNER_AGENTS_DIR: "agents",
        RUNNER_AGENTS: "sysreport,morningbrief,slow",
        RUNNER_DB: path.join(home, "laptop-runner.db"),
        RUNNER_BIND: "127.0.0.1:9301",
        AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
      },
    },
  ];
  return { processes };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const controllerModel = async () => {
  const res = await fetch(`${CONTROLLER_URL}/model`, { headers: { authorization: `Bearer ${FLEET_DEV_TOKEN}` } }).catch(() => null);
  return res?.ok ? (await res.json()).model : null;
};

/** Registers the local runner on a fresh Controller so the Fleet page isn't empty on first run. */
export async function registerLocalRunner() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const model = await controllerModel();
    if (model) {
      if (model.runners[LOCAL_RUNNER.name]) return;
      await fetch(`${CONTROLLER_URL}/msg`, {
        method: "POST",
        headers: { authorization: `Bearer ${FLEET_DEV_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ msg_id: `dev:add-runner:${LOCAL_RUNNER.name}`, type: "AddRunner", payload: LOCAL_RUNNER }),
      }).catch(() => null);
      console.log(`[fleet] registered the local runner "${LOCAL_RUNNER.name}"`);
      return;
    }
    await sleep(1_000);
  }
  console.warn("[fleet] the Controller didn't come up within 60s; local runner not registered");
}
