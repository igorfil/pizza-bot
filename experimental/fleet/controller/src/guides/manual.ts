import type { GuideResult, StepView } from "../types.js";
import { nameProblem, type RunnerGuide } from "./guide.js";

const form = (values: Record<string, string> = {}): StepView => ({
  title: "Add a runner by URL",
  body: "For a runner you started yourself and the Controller can reach directly.",
  fields: [
    { id: "name", label: "Name", kind: "text", value: values.name ?? "", hint: "e.g. laptop, homelab" },
    { id: "url", label: "Runner URL", kind: "text", value: values.url ?? "", hint: "as this Controller sees it, e.g. http://127.0.0.1:9301" },
    { id: "token", label: "Runner token", kind: "secret", hint: "the runner's RUNNER_TOKEN" },
  ],
  submit: "Add runner",
});

const validUrl = (url: string): boolean => /^https?:\/\/[^\s/]+/.test(url);

export const manualGuide: RunnerGuide = {
  id: "manual",
  title: "By URL",
  description: "A runner you started yourself: name, URL and token.",
  start: () => ({}),
  step: async (_state, input, ports): Promise<GuideResult> => {
    if (!input) return { kind: "ask", state: {}, view: form() };
    const name = (input.name ?? "").trim();
    const url = (input.url ?? "").trim().replace(/\/+$/, "");
    const token = input.token ?? "";
    const problem =
      nameProblem(name, ports.runnerNames) ?? (validUrl(url) ? null : "The URL must start with http:// or https://.") ?? (token ? null : "Enter the runner token.");
    if (problem) return { kind: "ask", state: {}, view: form({ name, url }), error: problem };
    return {
      kind: "done",
      runner: { name, transport: { kind: "direct", url }, token: { kind: "vault", key: token }, origin: { guide: "manual", summary: url, teardown: null } },
    };
  },
};
