/** Bundles each plugin into <plugin>/plugin.mjs, the one file its plugin.toml runs with Node. */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugins = ["python", "docker", "claude-code", "agentcore"];

await Promise.all(
  plugins.map((plugin) =>
    build({
      entryPoints: [path.join(root, "src", "bin", `${plugin}.ts`)],
      outfile: path.join(root, plugin, "plugin.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      // Some AWS SDK dependencies still call require(); ESM bundles need it defined.
      banner: { js: "import { createRequire as __fleetCreateRequire } from 'node:module';\nconst require = __fleetCreateRequire(import.meta.url);" },
      logLevel: "warning",
    }),
  ),
);
console.log(`bundled ${plugins.length} plugins`);
