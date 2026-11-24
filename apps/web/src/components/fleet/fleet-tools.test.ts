import { describe, expect, it } from "vitest";
import { mcpServerSummary } from "./AddAgentDialog.js";
import { skillServers } from "./fleet-skills.js";
import { parseServers } from "./McpServersDialog.js";

describe("parseServers", () => {
  it("files one server's entry under the id given", () => {
    expect(parseServers("fetch", '{"command": "uvx", "args": ["mcp-server-fetch"]}')).toEqual({
      servers: [["fetch", { command: "uvx", args: ["mcp-server-fetch"] }]],
    });
  });

  it("adds every server of a pasted .mcp.json", () => {
    expect(parseServers("", '{"mcpServers": {"fetch": {"command": "uvx"}, "time": {"command": "uvx"}}}')).toEqual({
      servers: [
        ["fetch", { command: "uvx" }],
        ["time", { command: "uvx" }],
      ],
    });
  });

  it("asks for an id when a single server has none", () => {
    expect(parseServers(" ", '{"command": "uvx"}')).toEqual({ error: "Give the server an id." });
  });
});

describe("skillServers", () => {
  it("names each MCP server a skill's tools come from once", () => {
    expect(skillServers(["mcp:playwright:browser_click", "mcp:playwright:*", "builtin:eval", "mcp:fetch:fetch"])).toEqual(["playwright", "fetch"]);
  });
});

describe("mcpServerSummary", () => {
  it("shows a stdio server's command line", () => {
    expect(mcpServerSummary({ command: "uvx", args: ["mcp-server-fetch"] })).toBe("uvx mcp-server-fetch");
  });

  it("shows an HTTP server's URL", () => {
    expect(mcpServerSummary({ url: "https://mcp.example.com/mcp" })).toBe("https://mcp.example.com/mcp");
  });
});
