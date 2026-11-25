/** Agent folders: `<dir>/<id>/agent.toml`, read the same way by every plugin that keeps its agents on disk. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import type { AgentInfo, Input } from "./protocol.js";

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

/** Every folder with an agent.toml, by id; a manifest that doesn't parse is skipped with a warning, and no folder means no agents. */
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
  };
};

export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
