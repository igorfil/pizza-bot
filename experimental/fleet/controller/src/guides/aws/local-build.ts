// TEMPORARY: lets the AWS guide install this checkout's build (FLEET_RUNNER_RELEASE=local) before a
// release exists. Remove with deploy/dev-build.sh and deploy/dev-push.sh once releases are tested.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fail, ok, type Outcome } from "../../outcome.js";
import { awsEnv } from "../../transport.js";
import type { AwsCredentials } from "../../types.js";
import type { SecretStore } from "../../vault.js";
import type { Arch } from "./port.js";

/** Where dev-push.sh puts the files on the instance, as the install script's release base. */
export const LOCAL_RELEASE_DIR = "file:///tmp/fleet-local";

const SCRIPT = fileURLToPath(new URL("../../../../deploy/dev-push.sh", import.meta.url));
const TIMEOUT_MS = 20 * 60_000;

export type PushLocalBuild = (instanceId: string, region: string, arch: Arch, credentials: AwsCredentials) => Promise<Outcome<void>>;

export const pushLocalBuild =
  (vault: SecretStore): PushLocalBuild =>
  async (instanceId, region, arch, credentials) => {
    const env = await awsEnv(vault, credentials);
    if (!env.ok) return env;
    return new Promise((resolve) => {
      const child = spawn("bash", [SCRIPT, instanceId, region, arch], {
        env: { ...process.env, ...env.value, AWS_PAGER: "" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
      });
      const lines: string[] = [];
      const keep = (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter((l) => l.trim() !== ""));
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.once("error", (e) => resolve(fail(e.message)));
      child.once("exit", (code) => resolve(code === 0 ? ok(undefined) : fail(lines.slice(-5).join("\n") || `dev-push.sh exited (${code ?? "signal"})`)));
    });
  };
