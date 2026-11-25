import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin's folder: where its bundled plugin.mjs sits, next to plugin.toml and agents/. */
export const pluginDir = (url: string): string => path.dirname(fileURLToPath(url));

/** A command from the environment, split on spaces, e.g. DOCKER="podman" or CLAUDE="npx claude". */
export const commandFrom = (value: string | undefined, fallback: string): [string, ...string[]] => {
  const [cli = fallback, ...rest] = (value ?? "").trim().split(/\s+/).filter(Boolean);
  return [cli, ...rest];
};
