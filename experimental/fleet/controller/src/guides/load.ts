import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attempt, fail, ok, type Outcome } from "../outcome.js";
import type { GuidePlugin, GuidePluginFactory, PluginHost } from "./plugin.js";

/** The module a plugin folder starts from; `.ts` loads through Node's type stripping. */
const ENTRIES = ["guide.ts", "guide.mjs", "guide.js"];

export type LoadedPlugins = { plugins: GuidePlugin[]; warnings: string[] };

const isFn = (v: unknown): boolean => typeof v === "function";
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const shapeProblem = (p: unknown): string | null => {
  const plugin = p as Partial<GuidePlugin> | null;
  if (!plugin || !isText(plugin.id)) return "its factory returned no plugin id";
  if (!Array.isArray(plugin.guides)) return "it has no guides list";
  if (plugin.transport !== undefined && !isFn(plugin.transport)) return "its transport is not a function";
  const bad = plugin.guides.find((g) => !g || !isText(g.id) || !isText(g.title) || !isText(g.description) || !isFn(g.start) || !isFn(g.step));
  return bad ? `guide ${String((bad as { id?: unknown } | null)?.id ?? "?")} needs id, title, description, start and step` : null;
};

const loadOne = async (folder: string, host: PluginHost): Promise<Outcome<GuidePlugin>> => {
  const entry = ENTRIES.map((e) => join(folder, e)).find((p) => existsSync(p));
  if (!entry) return fail(`it has none of ${ENTRIES.join(", ")}`);
  const loaded = await attempt(async () => {
    const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    return isFn(mod.default) ? ((await (mod.default as GuidePluginFactory)(host)) as unknown) : null;
  });
  if (!loaded.ok) return loaded;
  if (loaded.value === null) return fail(`${entry} has no default export function`);
  const problem = shapeProblem(loaded.value);
  return problem ? fail(problem) : ok(loaded.value as GuidePlugin);
};

const folders = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort()
    : [];

/** Plugin and guide ids must be unique, the built-in ones' included; a clash skips the later plugin. */
const clash = (plugin: GuidePlugin, kept: readonly GuidePlugin[]): string | null => {
  if (kept.some((p) => p.id === plugin.id)) return `plugin id ${plugin.id} is taken`;
  const ids = new Set(kept.flatMap((p) => p.guides.map((g) => g.id)));
  const taken = plugin.guides.find((g) => ids.has(g.id));
  return taken ? `guide id ${taken.id} is taken` : null;
};

/** Every plugin folder in `dir`, in name order; a folder that fails to load is skipped with a warning. */
export const loadGuidePlugins = async (dir: string, host: PluginHost, builtIn: readonly GuidePlugin[]): Promise<LoadedPlugins> => {
  const names = folders(dir);
  const results = await Promise.all(names.map((name) => loadOne(join(dir, name), host)));
  const { plugins, warnings } = results.reduce<LoadedPlugins & { all: GuidePlugin[] }>(
    (acc, r, i) => {
      const name = names[i]!;
      if (!r.ok) return { ...acc, warnings: [...acc.warnings, `runner-guide plugin ${name} skipped: ${r.error}`] };
      const problem = clash(r.value, acc.all);
      return problem
        ? { ...acc, warnings: [...acc.warnings, `runner-guide plugin ${name} skipped: ${problem}`] }
        : { plugins: [...acc.plugins, r.value], warnings: acc.warnings, all: [...acc.all, r.value] };
    },
    { plugins: [], warnings: [], all: [...builtIn] },
  );
  return { plugins, warnings };
};
