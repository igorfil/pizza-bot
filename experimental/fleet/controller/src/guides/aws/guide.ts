import { randomBytes, randomUUID } from "node:crypto";
import { fail, ok, type Outcome } from "../../outcome.js";
import type { AwsCredentials, GuideInput, GuideResult, GuideState, NewRunner, StepView, TransportSpec } from "../../types.js";
import { reveal } from "../../vault.js";
import { nameProblem, type GuidePorts, type RunnerGuide } from "../guide.js";
import { installScript, uninstallScript } from "./install.js";
import type { Arch, Ec2Host } from "./port.js";

const RUNNER_PORT = 9000;
const POLL_MS = 5_000;
const MAX_INSTALL_POLLS = 120;
const CHECK_TIMEOUT_MS = 45_000;
const DEFAULT_REGION = "us-west-2";
const AGENT_IDS = /^[a-z0-9_-]+(,[a-z0-9_-]+)*$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

type Step = "credentials" | "keys" | "target" | "install" | "installing" | "check";

/** Logged after every step: only ids, names and vault keys, never a secret. */
type AwsState = {
  step: Step;
  region?: string;
  credentials?: AwsCredentials;
  account?: string;
  arch?: Record<string, Arch>;
  instanceId?: string;
  name?: string;
  agents?: string;
  tokenKey?: string;
  commandId?: string;
  polls?: number;
};

const asState = (s: GuideState): AwsState => s as unknown as AwsState;
const toState = (s: AwsState): GuideState => s as unknown as GuideState;

const ask = (state: AwsState, view: StepView, error?: string): GuideResult =>
  error === undefined ? { kind: "ask", state: toState(state), view } : { kind: "ask", state: toState(state), view, error };
const working = (state: AwsState, title: string, progress: string): GuideResult => ({ kind: "working", state: toState(state), view: { title, progress, fields: [] } });
const failed = (state: AwsState, title: string, error: string): GuideResult => ({
  kind: "failed",
  state: toState(state),
  view: { title, fields: [], body: "Retry repeats this step; Cancel discards the guide." },
  error,
});

const credentialsView = async (ports: GuidePorts): Promise<StepView> => {
  const profiles = await ports.aws.profiles();
  return {
    title: "AWS credentials",
    body: "Pick how the Controller signs AWS calls. Profiles come from ~/.aws/config and ~/.aws/credentials.",
    fields: [
      {
        id: "source",
        label: "Credentials",
        kind: "choice",
        value: profiles[0] ? `profile:${profiles[0].name}` : "default",
        options: [
          ...profiles.map((p) => ({ value: `profile:${p.name}`, label: `Profile ${p.name}`, detail: p.region ?? "no region set" })),
          { value: "default", label: "Default credential chain", detail: "environment variables, SSO, instance role" },
          { value: "keys", label: "Enter an access key", detail: "stored in the OS vault" },
        ],
      },
      { id: "region", label: "Region", kind: "text", value: profiles.find((p) => p.region)?.region ?? DEFAULT_REGION },
    ],
    submit: "Continue",
  };
};

const keysView: StepView = {
  title: "AWS access key",
  body: "Both values go to the OS vault; the Controller keeps only a reference.",
  fields: [
    { id: "accessKeyId", label: "Access key id", kind: "secret" },
    { id: "secretAccessKey", label: "Secret access key", kind: "secret" },
  ],
  submit: "Continue",
};

const fromSource = (source: string): AwsCredentials | "keys" =>
  source === "keys" ? "keys" : source.startsWith("profile:") ? { kind: "profile", profile: source.slice("profile:".length) } : { kind: "default" };

const host = async (state: AwsState, ports: GuidePorts): Promise<Outcome<Ec2Host>> =>
  state.credentials && state.region ? ports.aws.host(state.credentials, state.region) : fail("credentials are not set");

const transportOf = (state: AwsState): TransportSpec => ({
  kind: "aws-ssm",
  region: state.region!,
  instanceId: state.instanceId!,
  remotePort: RUNNER_PORT,
  credentials: state.credentials!,
});

/** Verifies access, then lists where the runner can go. */
const target = async (state: AwsState, ports: GuidePorts, error?: string): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed(state, "Checking AWS access", h.error);
  const who = await h.value.whoAmI();
  if (!who.ok) return failed(state, "Checking AWS access", who.error);
  const ec2 = await h.value.canUseEc2();
  if (!ec2.ok) return failed(state, "Checking EC2 access", ec2.error);
  const listed = await h.value.instances();
  if (!listed.ok) return failed(state, "Listing instances", listed.error);
  const next: AwsState = { ...state, step: "target", account: who.value.account, arch: Object.fromEntries(listed.value.map((i) => [i.id, i.arch])) };
  const online = listed.value.find((i) => i.ssmOnline);
  const account = `Account ${who.value.account} (${who.value.arn}), ${state.region}.`;
  return ask(
    next,
    {
      title: "Which instance should run it?",
      body: online
        ? `${account} Only running instances whose SSM agent is online can be used.`
        : `${account} No running instance here has an online SSM agent. It needs an instance role with AmazonSSMManagedInstanceCore and outbound internet; then Retry.`,
      fields: [
        {
          id: "instance",
          label: "Instance",
          kind: "choice",
          value: state.instanceId ?? online?.id ?? "",
          options: listed.value.map((i) => ({
            value: i.id,
            label: i.name ? `${i.name} (${i.id})` : i.id,
            detail: `${i.type} · ${i.arch}${i.ssmOnline ? "" : " · SSM agent not online"}`,
            disabled: !i.ssmOnline,
          })),
        },
        { id: "name", label: "Runner name", kind: "text", value: state.name ?? "ec2" },
        { id: "agents", label: "Agents to serve", kind: "text", value: state.agents ?? "dadjokes", hint: "comma list of folder names from the agents tarball" },
      ],
      submit: "Set up runner",
    },
    error,
  );
};

const chooseTarget = (state: AwsState, input: GuideInput, ports: GuidePorts): Promise<GuideResult> | GuideResult => {
  const name = (input.name ?? "").trim();
  const agents = (input.agents ?? "").replace(/\s+/g, "");
  const instance = input.instance ?? "";
  const kept: AwsState = { ...state, name, agents };
  const problem =
    nameProblem(name, ports.runnerNames) ??
    (AGENT_IDS.test(agents) ? null : "List agents as comma-separated folder names.") ??
    (state.arch?.[instance] ? null : "Pick an instance.");
  if (problem) return target(kept, ports, problem);
  return working({ ...kept, step: "install", instanceId: instance }, "Installing the runner", "Starting…");
};

const runnerToken = async (state: AwsState, ports: GuidePorts): Promise<Outcome<{ key: string; token: string }>> => {
  if (state.tokenKey) {
    const existing = await reveal(ports.vault, { kind: "vault", key: state.tokenKey });
    return existing.ok ? ok({ key: state.tokenKey, token: existing.value }) : existing;
  }
  const key = `runner/${state.name}/${randomUUID()}`;
  const token = randomBytes(24).toString("hex");
  const stored = await ports.vault.set(key, token);
  return stored.ok ? ok({ key, token }) : stored;
};

const install = async (state: AwsState, ports: GuidePorts): Promise<GuideResult> => {
  if (!/^https:\/\/\S+$/.test(ports.release)) {
    return failed(state, "Installing the runner", "Set FLEET_RUNNER_RELEASE to the GitHub release download URL with the runner binaries (docs/RUNNER-GUIDES.md).");
  }
  const h = await host(state, ports);
  if (!h.ok) return failed(state, "Installing the runner", h.error);
  const token = await runnerToken(state, ports);
  if (!token.ok) return failed(state, "Installing the runner", token.error);
  const withToken: AwsState = { ...state, tokenKey: token.value.key };
  const script = installScript({
    release: ports.release.replace(/\/+$/, ""),
    arch: state.arch?.[state.instanceId!] ?? "arm64",
    token: token.value.token,
    agents: state.agents!,
    name: state.name!,
    region: state.region!,
    port: RUNNER_PORT,
  });
  const sent = await h.value.sendScript(state.instanceId!, script);
  if (!sent.ok) return failed(withToken, "Installing the runner", sent.error);
  return working({ ...withToken, step: "installing", commandId: sent.value, polls: 0 }, "Installing the runner", "Downloading the runner and agents…");
};

const waitInstall = async (state: AwsState, ports: GuidePorts): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed(state, "Installing the runner", h.error);
  const result = await h.value.scriptResult(state.instanceId!, state.commandId!);
  if (!result.ok) return failed(state, "Installing the runner", result.error);
  if (result.value.done) {
    return result.value.ok
      ? working({ ...state, step: "check" }, "Connecting", "Opening the tunnel…")
      : failed({ ...state, step: "install" }, "Installing the runner", result.value.output.trim().split("\n").slice(-5).join("\n") || "the install script failed");
  }
  const polls = (state.polls ?? 0) + 1;
  if (polls > MAX_INSTALL_POLLS) return failed({ ...state, step: "install" }, "Installing the runner", "the install script did not finish in 10 minutes");
  await ports.sleep(POLL_MS);
  return working({ ...state, polls }, "Installing the runner", `Installing… (${polls * (POLL_MS / 1000)}s)`);
};

const done = (state: AwsState): NewRunner => ({
  name: state.name!,
  transport: transportOf(state),
  token: { kind: "vault", key: state.tokenKey! },
  origin: {
    guide: "aws",
    summary: `EC2 ${state.instanceId} · ${state.region}`,
    teardown: { label: `uninstall the runner from ${state.instanceId}`, data: { instanceId: state.instanceId!, region: state.region! } },
  },
});

/** Opens the same tunnel the Controller will use from now on, and asks the runner for its agents. */
const check = async (state: AwsState, ports: GuidePorts): Promise<GuideResult> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  try {
    const link = await ports.transports(transportOf(state)).open(abort.signal);
    if (!link.ok) return failed(state, "Connecting", link.error);
    const res = await ports.fetch(`${link.value.url}/agents`, { signal: abort.signal }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (typeof res === "string") return failed(state, "Connecting", res);
    if (!res.ok) return failed(state, "Connecting", `the runner answered HTTP ${res.status}`);
    return { kind: "done", runner: done(state) };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
};

export const awsGuide: RunnerGuide = {
  id: "aws",
  title: "AWS EC2",
  description: "Put a runner on one of your running EC2 instances and reach it through an SSM tunnel.",
  start: () => toState({ step: "credentials" }),

  step: async (raw, input, ports) => {
    const state = asState(raw);
    switch (state.step) {
      case "credentials": {
        if (!input) return ask(state, await credentialsView(ports));
        const region = (input.region ?? "").trim();
        if (!REGION.test(region)) return ask(state, await credentialsView(ports), "Enter a region like us-west-2.");
        const source = fromSource(input.source ?? "default");
        if (source === "keys") return ask({ step: "keys", region }, keysView);
        return target({ step: "target", region, credentials: source }, ports);
      }
      case "keys": {
        if (!input) return ask(state, keysView);
        const accessKeyId = input.accessKeyId ?? "";
        const secretAccessKey = input.secretAccessKey ?? "";
        if (!accessKeyId || !secretAccessKey) return ask(state, keysView, "Enter both values.");
        return target(
          { ...state, step: "target", credentials: { kind: "keys", accessKeyId: { kind: "vault", key: accessKeyId }, secretAccessKey: { kind: "vault", key: secretAccessKey } } },
          ports,
        );
      }
      case "target":
        return input ? chooseTarget(state, input, ports) : target(state, ports);
      case "install":
        return install(state, ports);
      case "installing":
        return waitInstall(state, ports);
      case "check":
        return check(state, ports);
    }
  },

  teardown: async (runner, ports) => {
    const t = runner.transport;
    const data = runner.origin?.teardown?.data;
    if (t.kind !== "aws-ssm" || !data?.instanceId) return fail("this runner has no AWS instance to tear down");
    const h = await ports.aws.host(t.credentials, t.region);
    if (!h.ok) return h;
    const sent = await h.value.sendScript(data.instanceId, uninstallScript());
    return sent.ok ? ok(`uninstalling the runner from ${data.instanceId}`) : sent;
  },
};
