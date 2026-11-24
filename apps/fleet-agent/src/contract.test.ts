import { describe, expect, it } from "vitest";
import { finalReply, parseInput, statusFor } from "./contract.js";

const toolStarted = (tool_name: string, input: unknown) => ({
  method: "tools",
  params: { data: { event: "tool-started", tool_call_id: "c1", tool_name, input } },
});

describe("statusFor", () => {
  it("names the skill a delegation goes to", () => {
    expect(statusFor(toolStarted("task", JSON.stringify({ description: "x", subagent_type: "page-brief" })))).toBe("working with page-brief");
  });

  it("names any other tool", () => {
    expect(statusFor(toolStarted("fetch__fetch", { url: "https://example.com" }))).toBe("using fetch__fetch");
  });

  it("ignores frames that aren't a tool starting", () => {
    expect(statusFor({ method: "tools", params: { data: { event: "tool-finished", tool_call_id: "c1", output: "" } } })).toBeNull();
  });
});

describe("finalReply", () => {
  it("is the last assistant message with text", () => {
    const messages = [
      { type: "human", content: "hi" },
      { type: "ai", content: [{ type: "text", text: "the answer" }] },
      { type: "ai", content: "" },
    ];
    expect(finalReply(messages)).toBe("the answer");
  });
});

describe("parseInput", () => {
  it("defaults missing fields to empty", () => {
    expect(parseInput('{"input":"tacos"}')).toEqual({ taskId: "", contextId: "", input: "tacos" });
  });
});
