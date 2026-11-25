import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin's folder: where its bundled plugin.mjs sits, next to plugin.toml. */
const pluginDir = (url: string): string => path.dirname(fileURLToPath(url));

/** Agents added from the Fleet page, in the runner-given data folder, which stays writable where the plugin folder isn't (e.g. root-owned /opt on EC2). */
export const agentsDir = (url: string): string => path.join(process.env.FLEET_PLUGIN_DATA ?? path.join(pluginDir(url), ".state"), "agents");

/** A command from the environment, split on spaces, e.g. DOCKER="podman" or CLAUDE="npx claude". */
export const commandFrom = (value: string | undefined, fallback: string): [string, ...string[]] => {
  const [cli = fallback, ...rest] = (value ?? "").trim().split(/\s+/).filter(Boolean);
  return [cli, ...rest];
};
