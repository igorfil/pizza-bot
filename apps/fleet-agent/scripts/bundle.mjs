/** Bundles the harness into one file the fleet runner starts with `node`, plus the sandbox worker and its wasm. */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const outputDir = path.resolve(process.cwd(), process.argv[2] ?? "dist");

rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(outputDir, { recursive: true });

await build({
  // The eval worker is its own entry because `new Worker()` needs a real file beside main.js.
  entryPoints: {
    main: path.join(appRoot, "src", "main.ts"),
    "eval-worker": path.join(repoRoot, "packages", "runtime-langgraph", "src", "eval-worker.ts"),
  },
  outdir: outputDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["source"],
  // Native modules stay external so Node loads the binary for its own platform.
  external: ["better-sqlite3"],
  banner: {
    js: "import { createRequire as __pizzaCreateRequire } from 'node:module';\nconst require = __pizzaCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});

const quickJs = createRequire(require.resolve("@langchain/quickjs"));
cpSync(quickJs.resolve("@jitl/quickjs-ng-wasmfile-release-asyncify/wasm"), path.join(outputDir, "emscripten-module.wasm"));

console.log(`bundled fleet-agent -> ${outputDir}`);
