import { describe, expect, it } from "vitest";
import type { SkillCatalogEntry } from "@pizza-bot/core";
import { mcpStates, qualifyModel, withServerSkills } from "./agent-folder.js";

const providers = new Set(["bedrock", "anthropic"]);

const skill = (id: string, declaredTools: string[]): SkillCatalogEntry => ({
  id,
  name: id,
  description: id,
  source: "user",
  files: [],
  declaredTools,
  interruptOn: {},
});

describe("qualifyModel", () => {
  it("treats a bare id as Bedrock", () => {
    expect(qualifyModel("us.anthropic.claude-haiku-5-5", providers)).toBe("bedrock:us.anthropic.claude-haiku-5-5");
  });

  it("treats a Bedrock id with a version suffix as Bedrock", () => {
    expect(qualifyModel("us.amazon.nova-micro-v1:0", providers)).toBe("bedrock:us.amazon.nova-micro-v1:0");
  });

  it("keeps a known provider prefix", () => {
    expect(qualifyModel("anthropic:claude-sonnet-5-5", providers)).toBe("anthropic:claude-sonnet-5-5");
  });
});

describe("withServerSkills", () => {
  it("gives a server no skill grants a skill of its own", () => {
    const skills = withServerSkills(new Map(), { fetch: ["fetch"] });
    expect(skills.get("fetch-tools")?.declaredTools).toEqual(["mcp:fetch:*"]);
  });

  it("adds nothing for a server a skill already grants", () => {
    const skills = withServerSkills(new Map([["brief", skill("brief", ["mcp:fetch:fetch"])]]), { fetch: ["fetch"] });
    expect([...skills.keys()]).toEqual(["brief"]);
  });

  it("doesn't replace a skill that already has the generated id", () => {
    const skills = withServerSkills(new Map([["fetch-tools", skill("fetch-tools", [])]]), { fetch: ["fetch"] });
    expect(skills.get("fetch-tools-2")?.declaredTools).toEqual(["mcp:fetch:*"]);
  });
});

describe("mcpStates", () => {
  it("reports why a server that didn't connect is unavailable", () => {
    expect(mcpStates(["github"], {}, { github: "spawn ENOENT" }).get("github")).toEqual({ status: "unavailable", detail: "spawn ENOENT" });
  });
});
