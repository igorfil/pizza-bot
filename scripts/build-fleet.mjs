// Builds the parts of experimental/fleet that turbo can't: the Rust runner and the uv script agents'
// environments. The Controller is a workspace package, so `turbo run build` already covers it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoCommand } from "./fleet-dev.mjs";

const fleet = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "experimental", "fleet");
const agentsDir = path.join(fleet, "agents");

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

const isUvScript = (file) => existsSync(file) && readFileSync(file, "utf8").includes("# /// script");

run(cargoCommand(), ["build", "--locked"], path.join(fleet, "runner"));

readdirSync(agentsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(agentsDir, entry.name))
  .filter((dir) => isUvScript(path.join(dir, "agent.py")))
  .forEach((dir) => run("uv", ["sync", "--quiet", "--script", "agent.py"], dir));
