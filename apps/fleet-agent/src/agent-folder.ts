/** What one agent folder contributes to a run: its prompt, model, MCP servers and skills. */
import {
  composeSkillMd,
  pizzaBotSystemPrompt,
  SKILL_MD,
  SKILLS_ROOT,
  type McpDependencyState,
  type SkillCatalog,
  type SkillCatalogEntry,
} from "@pizza-bot/core";
import type { ToolCatalog } from "@pizza-bot/plugin-sdk";

const DEFAULT_PROVIDER = "bedrock";

/** Fleet manifests name a bare Bedrock id; a known provider prefix (`anthropic:…`) is kept. */
export const qualifyModel = (model: string, providers: ReadonlySet<string>): string => {
  const prefix = model.slice(0, model.indexOf(":"));
  return providers.has(prefix) ? model : `${DEFAULT_PROVIDER}:${model}`;
};

/** The runner's servers the agent picked; an id the runner no longer has is reported, not fatal. */
export const pickServers = <T>(library: Readonly<Record<string, T>>, ids: readonly string[]): { servers: Record<string, T>; missing: string[] } => ({
  servers: Object.fromEntries(ids.filter((id) => id in library).map((id) => [id, library[id]!])),
  missing: ids.filter((id) => !(id in library)),
});

/** `FLEET_MCP_SERVERS`: comma-separated ids. */
export const serverIds = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0);

export const systemPromptFor = (agentPrompt: string, hasSkills: boolean): string =>
  [pizzaBotSystemPrompt({ memories: false, subagents: hasSkills }), agentPrompt.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");

const grantsServer = (skill: SkillCatalogEntry, server: string): boolean =>
  skill.declaredTools.some((ref) => ref.startsWith(`mcp:${server}:`));

const serverSkill = (id: string, server: string, toolNames: readonly string[]): SkillCatalogEntry => {
  const description = `Does work with the ${server} MCP server's tools (${toolNames.join(", ")}).`;
  const body = `Use the ${server} tools to do what was asked, then report what you found or did.`;
  return {
    id,
    name: server,
    description,
    source: "user",
    files: [{ path: `${SKILLS_ROOT}/${id}/${SKILL_MD}`, content: composeSkillMd(id, description, body, [`mcp:${server}:*`]), mimeType: "text/markdown" }],
    declaredTools: [`mcp:${server}:*`],
    interruptOn: {},
  };
};

const freeId = (taken: ReadonlySet<string>, base: string): string => {
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
  const candidates = [`${slug}-tools`, ...Array.from({ length: 50 }, (_, i) => `${slug}-tools-${i + 2}`)];
  return candidates.find((c) => !taken.has(c)) ?? `${slug}-tools-${taken.size}`;
};

/**
 * Pizza Bot reaches MCP tools only through skills, so a connected server that no skill
 * grants gets a plain skill of its own; otherwise an agent with just `.mcp.json` couldn't use it.
 */
export const withServerSkills = (skills: SkillCatalog, catalog: ToolCatalog): SkillCatalog =>
  Object.entries(catalog)
    .filter(([server]) => ![...skills.values()].some((skill) => grantsServer(skill, server)))
    .reduce((acc, [server, toolNames]) => {
      const id = freeId(new Set(acc.keys()), server);
      return new Map([...acc, [id, serverSkill(id, server, toolNames)]]);
    }, new Map(skills));

export const mcpStates = (
  servers: readonly string[],
  catalog: ToolCatalog,
  errors: Readonly<Record<string, string>>,
): Map<string, McpDependencyState> =>
  new Map(
    servers.map((server): [string, McpDependencyState] =>
      server in catalog
        ? [server, { status: "ready" }]
        : [server, { status: "unavailable", detail: errors[server] ?? `${server} did not connect` }],
    ),
  );
