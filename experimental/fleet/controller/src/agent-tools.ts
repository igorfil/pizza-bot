/** Parses MCP servers and skill copies a UI sends; a string is the reason it can't. */
import type { SkillCopy, SkillFile } from "./types.js";

const MAX_MCP_TEXT = 20_000;
const MAX_SKILLS = 20;
const MAX_SKILL_BYTES = 2_000_000;
const ID = /^[a-z0-9_-]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** One server's entry, as JSON text or an object: `{"command": "uvx", "args": [...]}` or `{"url": "…"}`. */
export const mcpEntryFrom = (value: unknown): Record<string, unknown> | string => {
  if (typeof value === "string" && value.length > MAX_MCP_TEXT) return `an MCP server must be at most ${MAX_MCP_TEXT} characters`;
  const entry = typeof value === "string" ? parseJson(value) : value;
  if (!isObject(entry)) return 'an MCP server must be JSON like {"command": "uvx", "args": ["mcp-server-fetch"]}';
  const has = (key: string) => typeof entry[key] === "string" && (entry[key] as string).trim() !== "";
  return has("command") || has("url") ? entry : "an MCP server needs a command or a url";
};

export const mcpIdFrom = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

/** The runner's server ids an agent uses. */
export const mcpIdsFrom = (value: unknown): string[] | string => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => mcpIdFrom(id) !== null)) return "mcp must be a list of the runner's MCP server ids";
  return [...new Set(value as string[])];
};

const fileFrom = (value: unknown): SkillFile | null =>
  isObject(value) && typeof value.path === "string" && typeof value.content === "string"
    ? { path: value.path, content: value.content, ...(value.encoding === "base64" ? { encoding: "base64" as const } : {}) }
    : null;

const copyFrom = (value: unknown): SkillCopy | string => {
  if (!isObject(value) || typeof value.id !== "string" || !ID.test(value.id)) return "each skill needs an id of lowercase letters, digits, - or _";
  if (value.files === undefined) return { id: value.id };
  const files = Array.isArray(value.files) ? value.files.map(fileFrom) : [null];
  if (files.some((f) => f === null)) return `skill ${value.id} has a file without a path and content`;
  const valid = files as SkillFile[];
  if (!valid.some((f) => f.path === "SKILL.md")) return `skill ${value.id} has no SKILL.md`;
  if (valid.reduce((n, f) => n + f.content.length, 0) > MAX_SKILL_BYTES) return `skill ${value.id} is larger than ${MAX_SKILL_BYTES} bytes`;
  return { id: value.id, files: valid };
};

/** Copies of skills for an agent: `{id, files}` copies one, `{id}` keeps the copy it has. */
export const skillCopiesFrom = (value: unknown): SkillCopy[] | string => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "skills must be a list";
  if (value.length > MAX_SKILLS) return `an agent can have at most ${MAX_SKILLS} skills`;
  const copies = value.map(copyFrom);
  const problem = copies.find((c): c is string => typeof c === "string");
  if (problem) return problem;
  const ids = (copies as SkillCopy[]).map((c) => c.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  return twice ? `two skills are named ${twice}` : (copies as SkillCopy[]);
};
