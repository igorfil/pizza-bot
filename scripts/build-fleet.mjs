// Builds the parts of experimental/fleet that turbo can't: the Rust runner and its Linux builds for EC2.
// The Controller is a workspace package, so `turbo run build` already covers it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoCommand } from "./fleet-dev.mjs";

const fleet = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "experimental", "fleet");

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

run(cargoCommand(), ["build", "--locked"], path.join(fleet, "runner"));

const onPath = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
const canCrossBuild = () =>
  process.platform !== "win32" && onPath("zig") && (onPath("cargo-zigbuild") || existsSync(path.join(homedir(), ".cargo", "bin", "cargo-zigbuild")));

// TEMPORARY: the AWS guide copies these builds to an instance (deploy/dev-push.sh) until runner releases are published.
if (canCrossBuild()) {
  ["arm64", "x86_64"].forEach((arch) => run("bash", [path.join(fleet, "deploy", "dev-build.sh"), arch], fleet));
} else if (process.env.FLEET_REQUIRE_LINUX_RUNNER === "1") {
  throw new Error("the Linux runner builds for EC2 need zig and cargo-zigbuild (see experimental/fleet/docs/RUNNER-GUIDES.md)");
} else {
  console.warn("[fleet] skipping the Linux runner builds for EC2: they need zig and cargo-zigbuild (see experimental/fleet/docs/RUNNER-GUIDES.md)");
}

