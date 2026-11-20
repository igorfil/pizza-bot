// The experimental fleet's dev processes (Controller, laptop runner, EC2 tunnel), shared by
// `npm run dev` and `npm run dev:both`. Set PIZZA_FLEET=0 to start pizza-bot without the fleet.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveNpmCli } from "./npm-cli.mjs";

// Shared with the Fleet page's default connection (apps/web/src/components/fleet/fleet-client.ts).
export const FLEET_DEV_TOKEN = "fleet-dev-token";
const DEFAULT_EC2_INSTANCE = "<instance-id>";

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
        RUNNER_NAME: "laptop",
        RUNNER_TOKEN: "localtoken",
        RUNNER_LOCATION: "this laptop",
        RUNNER_AGENTS_DIR: "agents",
        RUNNER_AGENTS: "sysreport,morningbrief,slow",
        RUNNER_DB: path.join(home, "laptop-runner.db"),
        RUNNER_BIND: "127.0.0.1:9301",
        AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
      },
    },
  ];

  // Empty string skips the tunnel (e.g. no AWS access); the ec2 runner then shows as unreachable.
  const ec2 = process.env.FLEET_EC2_INSTANCE ?? DEFAULT_EC2_INSTANCE;
  if (ec2 && process.platform !== "win32") {
    processes.push({ name: "fleet-tunnel", command: "bash", args: [path.join(fleet, "deploy", "tunnel.sh"), ec2], cwd: fleet, env: {} });
  }
  return { processes };
}
