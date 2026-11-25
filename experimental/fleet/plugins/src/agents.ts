/** Agent folders: `<dir>/<id>/agent.toml`, read the same way by every plugin that keeps its agents on disk. */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { fail, ok, type AddField, type Adding, type AgentInfo, type Input, type Result } from "./protocol.js";

export type Manifest = Record<string, unknown>;

export type AgentFolder = { id: string; dir: string; manifest: Manifest };

const log = (line: string) => process.stderr.write(`${line}\n`);

const readFolder = async (dir: string, id: string): Promise<AgentFolder | null> => {
  const folder = path.join(dir, id);
  const text = await readFile(path.join(folder, "agent.toml"), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return { id, dir: folder, manifest: parse(text) as Manifest };
  } catch (e) {
    log(`skipping ${id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** Every folder in `dir` with an agent.toml, by id; a manifest that doesn't parse is skipped with a warning,
 * and a missing folder means no agents. */
export async function readAgentFolders(dir: string): Promise<AgentFolder[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const folders = await Promise.all(ids.map((id) => readFolder(dir, id)));
  return folders.filter((f): f is AgentFolder => f !== null);
}

export const text = (m: Manifest, key: string): string | undefined => (typeof m[key] === "string" ? m[key] : undefined);

export const strings = (m: Manifest, key: string): string[] => (Array.isArray(m[key]) ? m[key].map(String) : []);

export const stringMap = (m: Manifest, key: string): Record<string, string> => {
  const value = m[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) : {};
};

const inputOf = (m: Manifest): Input | undefined => {
  const value = m.input;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Manifest;
  const label = text(input, "label");
  if (!label) return undefined;
  const hint = text(input, "hint");
  const example = text(input, "example");
  return { label, ...(hint !== undefined ? { hint } : {}), ...(example !== undefined ? { example } : {}) };
};

/** The fields every agent.toml shares: name, description, input, timeout_secs. */
/** Every agent a plugin lists was added through it, so removing one deletes it. */
export const agentInfo = ({ id, manifest: m }: AgentFolder): AgentInfo => {
  const description = text(m, "description");
  const input = inputOf(m);
  const timeoutSecs = typeof m.timeout_secs === "number" ? m.timeout_secs : undefined;
  return {
    id,
    name: text(m, "name") ?? id,
    ...(description !== undefined ? { description } : {}),
    ...(input ? { input } : {}),
    ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
    added: true,
  };
};

export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Release notes bot!" → "release-notes-bot", the same ids the runner gives created agents. */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const NAME_FIELD: AddField = { id: "name", label: "Name", kind: "text", required: true, placeholder: "e.g. Release notes" };

export const DESCRIPTION_FIELD: AddField = { id: "description", label: "Description", kind: "text", hint: "shown on the agent's card" };

/** A comma-separated field as its words. */
export const list = (value: string | undefined): string[] => (value ?? "").split(",").map((w) => w.trim()).filter(Boolean);

/** An absolute path to a folder that exists on this machine, or why not. */
export const existingFolder = async (value: string, label: string): Promise<Result<string>> => {
  if (!path.isAbsolute(value)) return fail(`${label} must be an absolute path on the runner's machine`);
  const isDir = await stat(value).then((s) => s.isDirectory(), () => false);
  return isDir ? ok(value) : fail(`${label} ${value} isn't a folder on the runner's machine`);
};

/** Drops fields with no value, so the manifest only says what was filled in. */
const filled = (m: Manifest): Manifest => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));

/**
 * Adding agents to `dir`: checks required fields, turns the values into a manifest with `toManifest`,
 * and writes `<id>/agent.toml` under an id made from the name.
 */
export const folderAdding = (dir: string, fields: AddField[], toManifest: (values: Record<string, string>) => Promise<Result<Manifest>>): Adding => ({
  fields,
  add: async (values) => {
    const missing = fields.find((f) => f.required && !values[f.id]);
    if (missing) return fail(`${missing.label} is required`);
    const id = slug(values.name ?? "");
    if (!id) return fail("the name needs at least one letter or digit");
    if ((await readAgentFolders(dir)).some((a) => a.id === id)) return fail(`there is already an agent ${JSON.stringify(id)}; pick another name`);
    const manifest = await toManifest(values);
    if (!manifest.ok) return manifest;
    const folder = path.join(dir, id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "agent.toml"), stringify(filled({ name: values.name, description: values.description, ...manifest.value })));
    return ok(id);
  },
  remove: async (agentId) => {
    const folder = (await readAgentFolders(dir)).find((a) => a.id === agentId);
    if (!folder) return fail(`there is no agent ${JSON.stringify(agentId)}`);
    await rm(folder.dir, { recursive: true, force: true });
    return ok(null);
  },
});
