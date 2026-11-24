/** Parses the MCP servers and skills a UI sends with CreateAgent / EditAgent; a string is the reason it can't. */
import type { AgentSkill, McpServers } from "./types.js";

const MAX_MCP_TEXT = 20_000;
const MAX_SKILLS = 20;
const MAX_SKILL = 50_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Takes `.mcp.json` text (`{"mcpServers": {...}}`) or the bare server map; empty means none. */
export const mcpServersFrom = (value: unknown): McpServers | string => {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return {};
  if (typeof value === "string" && value.length > MAX_MCP_TEXT) return `MCP servers must be at most ${MAX_MCP_TEXT} characters`;
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isObject(parsed)) return 'MCP servers must be JSON like {"mcpServers": {"fetch": {"command": "uvx", "args": ["mcp-server-fetch"]}}}';
  const servers = isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const bad = Object.entries(servers).find(([, s]) => !isObject(s) || (typeof s.command !== "string" && typeof s.url !== "string"));
  if (bad) return `MCP server "${bad[0]}" needs a command or a url`;
  return servers as McpServers;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const field = (frontmatter: string, key: string): string =>
  new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

/** Each skill is a whole SKILL.md; its frontmatter `name` becomes the folder id. */
export const skillsFrom = (value: unknown): AgentSkill[] | string => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((s) => typeof s === "string")) return "skills must be a list of SKILL.md texts";
  if (value.length > MAX_SKILLS) return `an agent can have at most ${MAX_SKILLS} skills`;
  const skills: AgentSkill[] = [];
  for (const [i, content] of (value as string[]).entries()) {
    const frontmatter = FRONTMATTER.exec(content)?.[1];
    const id = frontmatter ? slug(field(frontmatter, "name")) : "";
    if (!frontmatter || !id || !field(frontmatter, "description")) return `skill ${i + 1} needs frontmatter with a name and a description`;
    if (content.length > MAX_SKILL) return `skill ${id} must be at most ${MAX_SKILL} characters`;
    if (skills.some((s) => s.id === id)) return `two skills are named ${id}`;
    skills.push({ id, content });
  }
  return skills;
};
