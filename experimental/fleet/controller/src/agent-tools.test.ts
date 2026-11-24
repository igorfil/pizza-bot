import { describe, expect, it } from "vitest";
import { mcpEntryFrom, mcpIdsFrom, skillCopiesFrom } from "./agent-tools.js";

describe("mcpEntryFrom", () => {
  it("reads a server from JSON text", () => {
    expect(mcpEntryFrom('{"command": "uvx", "args": ["mcp-server-fetch"]}')).toEqual({ command: "uvx", args: ["mcp-server-fetch"] });
  });

  it("refuses text that isn't JSON", () => {
    expect(mcpEntryFrom("{command")).toContain("must be JSON");
  });

  it("refuses a server with neither a command nor a url", () => {
    expect(mcpEntryFrom({ args: [] })).toBe("an MCP server needs a command or a url");
  });
});

describe("mcpIdsFrom", () => {
  it("drops repeated ids", () => {
    expect(mcpIdsFrom(["fetch", "fetch"])).toEqual(["fetch"]);
  });

  it("refuses an id unsafe for a URL", () => {
    expect(mcpIdsFrom(["My Server"])).toContain("MCP server ids");
  });
});

const skillMd = { path: "SKILL.md", content: "---\nname: brief\ndescription: Briefs.\n---\nBe brief." };

describe("skillCopiesFrom", () => {
  it("keeps a skill named without files", () => {
    expect(skillCopiesFrom([{ id: "brief" }])).toEqual([{ id: "brief" }]);
  });

  it("refuses a copy without a SKILL.md", () => {
    expect(skillCopiesFrom([{ id: "brief", files: [{ path: "notes.md", content: "x" }] }])).toBe("skill brief has no SKILL.md");
  });

  it("refuses two skills with one id", () => {
    expect(skillCopiesFrom([{ id: "brief", files: [skillMd] }, { id: "brief" }])).toBe("two skills are named brief");
  });
});
