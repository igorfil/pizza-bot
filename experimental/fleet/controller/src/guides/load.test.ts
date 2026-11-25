import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { memoryVault } from "../vault.js";
import { nameProblem } from "./guide.js";
import { loadGuidePlugins } from "./load.js";
import type { GuidePlugin, PluginHost } from "./plugin.js";

const root = mkdtempSync(join(tmpdir(), "runner-guides-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const host: PluginHost = {
  vault: memoryVault(),
  transports: () => ({ open: async () => ({ ok: false, error: "none" }) }),
  localBuildDir: "/build",
  nameProblem,
};

const guideSource = (id: string) =>
  `{ id: "${id}", title: "T ${id}", description: "D", start: () => ({}), step: async (s) => ({ kind: "failed", state: s, view: { title: "x", fields: [] }, error: "e" }) }`;

/** A folder of plugin folders; each value is the entry file's name and source. */
const pluginsDir = (name: string, plugins: Record<string, [string, string]>): string => {
  const dir = join(root, name);
  Object.entries(plugins).forEach(([folder, [file, source]]) => {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, file), source);
  });
  return dir;
};

const builtIn: GuidePlugin[] = [{ id: "aws", guides: [] }];

describe("loadGuidePlugins", () => {
  test("loads .mjs and .ts plugins in folder-name order, passing them the host", async () => {
    const dir = pluginsDir("ok", {
      b: ["guide.mjs", `export default (host) => ({ id: "b", guides: [${guideSource("b-guide")}], dir: host.localBuildDir });`],
      a: ["guide.ts", `import type { GuidePluginFactory } from "x";\nconst f: GuidePluginFactory = () => ({ id: "a", guides: [${guideSource("a-guide")}] });\nexport default f;`],
    });
    const { plugins, warnings } = await loadGuidePlugins(dir, host, builtIn);
    expect([plugins.map((p) => p.guides[0]?.id), (plugins[1] as unknown as { dir: string }).dir, warnings]).toEqual([["a-guide", "b-guide"], "/build", []]);
  });

  test("a missing folder means no plugins", async () => {
    expect(await loadGuidePlugins(join(root, "nope"), host, builtIn)).toEqual({ plugins: [], warnings: [] });
  });

  test("broken plugins are skipped with a warning each, the rest still load", async () => {
    const dir = pluginsDir("broken", {
      empty: ["README.md", "nothing to run"],
      throws: ["guide.mjs", `export default () => { throw new Error("boom"); };`],
      shape: ["guide.mjs", `export default () => ({ id: "shape", guides: [{ id: "g" }] });`],
      good: ["guide.mjs", `export default () => ({ id: "good", guides: [${guideSource("good")}] });`],
    });
    const { plugins, warnings } = await loadGuidePlugins(dir, host, builtIn);
    expect([plugins.map((p) => p.id), warnings]).toEqual([
      ["good"],
      [
        "runner-guide plugin empty skipped: it has none of guide.ts, guide.mjs, guide.js",
        "runner-guide plugin shape skipped: guide g needs id, title, description, start and step",
        "runner-guide plugin throws skipped: boom",
      ],
    ]);
  });

  test("a plugin whose plugin or guide id is already taken is skipped", async () => {
    const dir = pluginsDir("clash", {
      a: ["guide.mjs", `export default () => ({ id: "aws", guides: [] });`],
      b: ["guide.mjs", `export default () => ({ id: "first", guides: [${guideSource("same")}] });`],
      c: ["guide.mjs", `export default () => ({ id: "second", guides: [${guideSource("same")}] });`],
    });
    const { plugins, warnings } = await loadGuidePlugins(dir, host, builtIn);
    expect([plugins.map((p) => p.id), warnings]).toEqual([
      ["first"],
      ["runner-guide plugin a skipped: plugin id aws is taken", "runner-guide plugin c skipped: guide id same is taken"],
    ]);
  });
});
