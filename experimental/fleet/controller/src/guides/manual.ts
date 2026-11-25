import type { GuideInput, GuideResult, GuideState, NewRunner, StepView } from "../types.js";
import { nameProblem, type GuidePorts, type RunnerGuide } from "./guide.js";

const CHECK_TIMEOUT_MS = 15_000;

/** Logged; `tokenKey` is the vault key the API stored the typed token under. */
type ManualState = { name?: string; url?: string; tokenKey?: string };

const view = (state: ManualState): StepView => ({
  title: "Runner at a URL",
  body: "A runner you started yourself. The Controller calls it at this URL with this token; the token goes to the OS vault.",
  fields: [
    { id: "name", label: "Runner name", kind: "text", value: state.name ?? "" },
    { id: "url", label: "URL", kind: "text", hint: "e.g. http://127.0.0.1:9301", value: state.url ?? "" },
    { id: "token", label: "Token", kind: "secret", hint: state.tokenKey ? "Leave empty to keep the one entered before." : "The runner's RUNNER_TOKEN." },
  ],
  submit: "Add runner",
});

const ask = (state: ManualState, error?: string): GuideResult =>
  error === undefined ? { kind: "ask", state, view: view(state) } : { kind: "ask", state, view: view(state), error };

const urlProblem = (url: string): string | null => (/^https?:\/\/[^\s/]+/.test(url) ? null : "The URL must start with http:// or https://.");

/** `/agents` answers without the token, so a runner that answers it is up. */
const reachProblem = async (url: string, ports: GuidePorts): Promise<string | null> => {
  const res = await ports.fetch(`${url}/agents`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (typeof res === "string") return `No runner answered at ${url}: ${res}`;
  return res.ok ? null : `${url} answered HTTP ${res.status}; is it a runner?`;
};

const runnerOf = (name: string, url: string, tokenKey: string): NewRunner => ({
  name,
  transport: { kind: "direct", url },
  token: { kind: "vault", key: tokenKey },
  origin: { guide: "manual", summary: url, teardown: null },
});

const submit = async (state: ManualState, input: GuideInput, ports: GuidePorts): Promise<GuideResult> => {
  const name = (input.name ?? "").trim();
  const url = (input.url ?? "").trim().replace(/\/+$/, "");
  const tokenKey = input.token || state.tokenKey;
  const next: ManualState = { name, url, ...(tokenKey ? { tokenKey } : {}) };
  const problem = nameProblem(name, ports.runnerNames) ?? urlProblem(url) ?? (tokenKey ? null : "Enter the runner's token.") ?? (await reachProblem(url, ports));
  return problem ? ask(next, problem) : { kind: "done", runner: runnerOf(name, url, tokenKey!) };
};

export const manualGuide: RunnerGuide = {
  id: "manual",
  title: "By URL",
  description: "A runner you started yourself, reached at its URL.",
  start: () => ({}),
  step: async (raw: GuideState, input, ports) => {
    const state = raw as ManualState;
    return input ? submit(state, input, ports) : ask(state);
  },
};
