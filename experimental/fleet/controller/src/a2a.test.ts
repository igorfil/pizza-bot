import { describe, expect, test } from "vitest";
import { agentKind, pluginsOf } from "./a2a.js";

describe("agent kind", () => {
  test.each([
    ["builtin", "pizza-bot", "builtin"],
    ["external", "pizza-bot", "external"],
    [undefined, "pizza-bot", "builtin"],
    [undefined, null, "external"],
    [undefined, "docker", "external"],
  ])("kind %j with harness %j is %s", (kind, harness, expected) => {
    expect(agentKind(kind, harness)).toBe(expected);
  });
});

describe("plugins in a runner's index", () => {
  test("keeps what the runner reports and drops entries without an id", () => {
    const reported = [{ id: "python", name: "Python", version: "1", capabilities: ["cancel"], healthy: true, detail: "1 agent" }, { name: "nameless" }, "junk"];
    expect(pluginsOf(reported)).toEqual([{ id: "python", name: "Python", version: "1", capabilities: ["cancel"], healthy: true, detail: "1 agent" }]);
  });

  test("a runner from before plugins has none", () => {
    expect(pluginsOf(undefined)).toEqual([]);
  });
});
