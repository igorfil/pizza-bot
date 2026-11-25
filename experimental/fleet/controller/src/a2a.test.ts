import { describe, expect, test } from "vitest";
import { addFieldsOf, agentKind, pluginIconsOf, pluginsOf } from "./a2a.js";

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
    expect(pluginsOf(reported)).toEqual([{ id: "python", name: "Python", version: "1", capabilities: ["cancel"], healthy: true, detail: "1 agent", addFields: [] }]);
  });

  test("a runner from before plugins has none", () => {
    expect(pluginsOf(undefined)).toEqual([]);
  });

  test("keeps icons apart from the plugins, only for plugins that have one", () => {
    const reported = [{ id: "docker", icon: "<svg/>" }, { id: "python" }, { icon: "<svg/>" }];
    expect([pluginIconsOf(reported), "icon" in (pluginsOf(reported)[0] ?? {})]).toEqual([{ docker: "<svg/>" }, false]);
  });
});

describe("what a plugin asks for to add an agent", () => {
  test("keeps well-formed fields, drops ones without an id or label, and reads an unknown kind as text", () => {
    const reported = [
      { id: "image", label: "Image", kind: "text", required: true, placeholder: "alpine" },
      { id: "dir", label: "Folder", kind: "path", hint: "on the runner" },
      { id: "x", label: "X", kind: "color" },
      { label: "No id" },
    ];
    expect(addFieldsOf(reported)).toEqual([
      { id: "image", label: "Image", kind: "text", required: true, placeholder: "alpine" },
      { id: "dir", label: "Folder", kind: "path", hint: "on the runner" },
      { id: "x", label: "X", kind: "text" },
    ]);
  });
});
