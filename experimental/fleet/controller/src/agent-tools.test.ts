import { describe, expect, it } from "vitest";
import { mcpServersFrom, skillsFrom } from "./agent-tools.js";

const fetchServer = { command: "uvx", args: ["mcp-server-fetch"] };

describe("mcpServersFrom", () => {
  it("reads the servers out of .mcp.json text", () => {
    expect(mcpServersFrom(JSON.stringify({ mcpServers: { fetch: fetchServer } }))).toEqual({ fetch: fetchServer });
  });

  it("takes a bare server map", () => {
    expect(mcpServersFrom(JSON.stringify({ fetch: fetchServer }))).toEqual({ fetch: fetchServer });
  });

  it("treats blank text as no servers", () => {
    expect(mcpServersFrom("  ")).toEqual({});
  });

  it("refuses text that isn't JSON", () => {
    expect(mcpServersFrom("{fetch")).toContain("must be JSON");
  });

  it("refuses a server with neither a command nor a url", () => {
    expect(mcpServersFrom(JSON.stringify({ mcpServers: { fetch: { args: [] } } }))).toBe('MCP server "fetch" needs a command or a url');
  });
});

const skill = (name: string) => `---\nname: ${name}\ndescription: Briefs on pages.\n---\nBe brief.`;

describe("skillsFrom", () => {
  it("names each skill's folder after its frontmatter name", () => {
    expect(skillsFrom([skill('"Page Brief"')])).toEqual([{ id: "page-brief", content: skill('"Page Brief"') }]);
  });

  it("refuses a skill without a description", () => {
    expect(skillsFrom(["---\nname: brief\n---\nBe brief."])).toBe("skill 1 needs frontmatter with a name and a description");
  });

  it("refuses two skills with one name", () => {
    expect(skillsFrom([skill("brief"), skill("brief")])).toBe("two skills are named brief");
  });
});
