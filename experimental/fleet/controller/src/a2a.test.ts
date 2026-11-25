import { describe, expect, test } from "vitest";
import { agentKind } from "./a2a.js";

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
