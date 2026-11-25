import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDirs } from "../agents.js";

/** The plugin's folder: where its bundled plugin.mjs sits, next to plugin.toml and agents/. */
const pluginDir = (url: string): string => path.dirname(fileURLToPath(url));

/**
 * Shipped agents in `<plugin>/agents` (or the plugin's own variable); added ones in the runner-given data folder,
 * which stays writable where the plugin folder isn't (e.g. root-owned /opt on EC2).
 */
export const agentDirs = (url: string, shipped: string | undefined): AgentDirs => ({
  shipped: shipped ?? path.join(pluginDir(url), "agents"),
  added: path.join(process.env.FLEET_PLUGIN_DATA ?? path.join(pluginDir(url), ".state"), "agents"),
});

/** A command from the environment, split on spaces, e.g. DOCKER="podman" or CLAUDE="npx claude". */
export const commandFrom = (value: string | undefined, fallback: string): [string, ...string[]] => {
  const [cli = fallback, ...rest] = (value ?? "").trim().split(/\s+/).filter(Boolean);
  return [cli, ...rest];
};
