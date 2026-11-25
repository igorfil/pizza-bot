import { randomBytes, randomUUID } from "node:crypto";
import { fail, ok, type Outcome } from "../../outcome.js";
import type { AwsCredentials, ChecklistItem, GuideInput, GuideResult, GuideState, NewRunner, StepView, TransportSpec } from "../../types.js";
import { reveal } from "../../vault.js";
import { nameProblem, type GuidePorts, type RunnerGuide } from "../guide.js";
import { AGENT_MODELS, BEDROCK_PROBE_MODEL } from "../../agent-models.js";
import { bedrockScript, detectScript, installScript, parseBedrock, parseDetect, uninstallScript } from "./install.js";
import { LOCAL_RELEASE_DIR, type PushLocalBuild } from "./local-build.js";
import type { Arch, AwsPort, Ec2Host, Instance } from "./port.js";

export type AwsGuideDeps = {
  aws: AwsPort;
  /** TEMPORARY: copies this checkout's runner build to an instance, the only install source until releases exist. */
  pushLocalBuild: PushLocalBuild;
};

export type AwsPorts = GuidePorts & AwsGuideDeps;

const RUNNER_PORT = 9000;
const POLL_MS = 5_000;
const MAX_INSTALL_POLLS = 120;
const MAX_DETECT_POLLS = 24;
const CHECK_TIMEOUT_MS = 45_000;

const modelLabel = (id: string): string => AGENT_MODELS.find((m) => m.id === id)?.label ?? id;

const probing = `Calling ${modelLabel(BEDROCK_PROBE_MODEL)} from the instance…`;

/** Where account-wide calls go when the profile names no region. */
const HOME_REGION = "us-east-1";

type Step = "credentials" | "keys" | "target" | "detect" | "detecting" | "push" | "install" | "installing" | "check" | "bedrock" | "bedrocking";

/** Logged after every step: only ids, names and vault keys, never a secret. */
type AwsState = {
  step: Step;
  /** For account-wide calls: the profile's region, else HOME_REGION. */
  homeRegion?: string;
  /** The chosen instance's region. */
  region?: string;
  credentials?: AwsCredentials;
  account?: string;
  found?: Record<string, { region: string; arch: Arch }>;
  instanceId?: string;
  name?: string;
  tokenKey?: string;
  remotePort?: number;
  /** The instance already ran a runner, so the Controller adopted it instead of installing. */
  adopted?: boolean;
  commandId?: string;
  polls?: number;
};

const asState = (s: GuideState): AwsState => s as unknown as AwsState;
const toState = (s: AwsState): GuideState => s as unknown as GuideState;

const STEP_LABELS = ["Sign in", "Pick instance", "Set up"];

const stepsOf = (step: Step): NonNullable<StepView["steps"]> => ({
  labels: STEP_LABELS,
  current: step === "credentials" || step === "keys" ? 0 : step === "target" ? 1 : 2,
});

const ask = (state: AwsState, view: StepView, error?: string): GuideResult => {
  const v = { ...view, steps: stepsOf(state.step) };
  return error === undefined ? { kind: "ask", state: toState(state), view: v } : { kind: "ask", state: toState(state), view: v, error };
};
type SetupItem = { key: "connect" | "push" | "install" | "tunnel" | "bedrock"; label: string; steps: Step[] };

const SETUP: SetupItem[] = [
  { key: "connect", label: "Connect to the instance", steps: ["detect", "detecting"] },
  { key: "push", label: "Copy the local build", steps: ["push"] },
  { key: "install", label: "Install the runner", steps: ["install", "installing"] },
  { key: "tunnel", label: "Open the tunnel to the runner", steps: ["check"] },
  { key: "bedrock", label: "Verify Bedrock access", steps: ["bedrock", "bedrocking"] },
];

const SETUP_TITLE = "Setting up the runner";

/** The set-up as a checklist: done before the current step, then the current one, then pending. */
const checklistOf = (state: AwsState, failedNow: boolean, progress?: string): StepView["checklist"] => {
  const items = SETUP;
  const at = items.findIndex((i) => i.steps.includes(state.step));
  if (at < 0) return undefined;
  return items.map((item, n): ChecklistItem => {
    if (state.adopted && (item.key === "push" || item.key === "install")) return { label: item.label, state: "skipped", detail: "a runner is already installed" };
    if (n < at) return { label: item.label, state: "done" };
    if (n > at) return { label: item.label, state: "pending" };
    return { label: item.label, state: failedNow ? "failed" : "current", ...(progress && !failedNow ? { detail: progress } : {}) };
  });
};

const working = (state: AwsState, title: string, progress: string): GuideResult => {
  const checklist = checklistOf(state, false, progress);
  return {
    kind: "working",
    state: toState(state),
    view: { title: checklist ? SETUP_TITLE : title, progress, fields: [], steps: stepsOf(state.step), ...(checklist ? { checklist } : {}) },
  };
};
const failed = (state: AwsState, title: string, error: string): GuideResult => {
  const checklist = checklistOf(state, true);
  return {
    kind: "failed",
    state: toState(state),
    view: {
      title: checklist ? SETUP_TITLE : title,
      fields: [],
      body: "Retry repeats this step; Cancel discards the guide.",
      steps: stepsOf(state.step),
      ...(checklist ? { checklist } : {}),
    },
    error,
  };
};

const credentialsView = async (ports: AwsPorts): Promise<StepView> => {
  const profiles = await ports.aws.profiles();
  return {
    title: "AWS credentials",
    body: "Pick how the Controller signs AWS calls. Profiles come from ~/.aws/config and ~/.aws/credentials. Every enabled region is searched for instances.",
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

const homeRegionOf = async (source: AwsCredentials | "keys", ports: AwsPorts): Promise<string> => {
  if (source === "keys" || source.kind !== "profile") return HOME_REGION;
  const profiles = await ports.aws.profiles();
  return profiles.find((p) => p.name === source.profile)?.region ?? HOME_REGION;
};

const fromSource = (source: string): AwsCredentials | "keys" =>
  source === "keys" ? "keys" : source.startsWith("profile:") ? { kind: "profile", profile: source.slice("profile:".length) } : { kind: "default" };

const hostIn = async (state: AwsState, region: string | undefined, ports: AwsPorts): Promise<Outcome<Ec2Host>> =>
  state.credentials && region ? ports.aws.host(state.credentials, region) : fail("credentials are not set");

const host = (state: AwsState, ports: AwsPorts): Promise<Outcome<Ec2Host>> => hostIn(state, state.region, ports);

type Found = Instance & { region: string };

/** Regions that fail (e.g. blocked by an SCP) are skipped, so one bad region doesn't hide the rest. */
const scan = async (state: AwsState, regions: string[], ports: AwsPorts): Promise<{ found: Found[]; failed: string[] }> => {
  const results = await Promise.all(
    regions.map(async (region) => {
      const h = await hostIn(state, region, ports);
      const listed = h.ok ? await h.value.instances() : h;
      return { region, listed };
    }),
  );
  return {
    found: results.flatMap(({ region, listed }) => (listed.ok ? listed.value.map((i) => ({ ...i, region })) : [])),
    failed: results.filter((r) => !r.listed.ok).map((r) => r.region),
  };
};

const byUsability = (a: Found, b: Found): number => Number(b.ssmOnline) - Number(a.ssmOnline) || a.region.localeCompare(b.region) || a.id.localeCompare(b.id);

const transportOf = (state: AwsState): TransportSpec => ({
  kind: "aws_ssm",
  region: state.region!,
  instanceId: state.instanceId!,
  remotePort: state.remotePort ?? RUNNER_PORT,
  credentials: state.credentials!,
});

/** Verifies access, then lists where the runner can go across every enabled region. */
const target = async (state: AwsState, ports: AwsPorts, error?: string): Promise<GuideResult> => {
  const h = await hostIn(state, state.homeRegion, ports);
  if (!h.ok) return failed(state, "Checking AWS access", h.error);
  const who = await h.value.whoAmI();
  if (!who.ok) return failed(state, "Checking AWS access", who.error);
  const ec2 = await h.value.canUseEc2();
  if (!ec2.ok) return failed(state, "Checking EC2 access", ec2.error);
  const regions = await h.value.regions();
  if (!regions.ok) return failed(state, "Listing regions", regions.error);
  const { found, failed: unscanned } = await scan(state, regions.value, ports);
  if (found.length === 0 && unscanned.length === regions.value.length) return failed(state, "Listing instances", `no region could be searched (${unscanned.join(", ")})`);
  const listed = [...found].sort(byUsability);
  const next: AwsState = { ...state, step: "target", account: who.value.account, found: Object.fromEntries(listed.map((i) => [i.id, { region: i.region, arch: i.arch }])) };
  const online = listed.find((i) => i.ssmOnline);
  const searched = regions.value.length - unscanned.length;
  const account = `Account ${who.value.account} (${who.value.arn}), ${searched} ${searched === 1 ? "region" : "regions"} searched${unscanned.length > 0 ? ` (could not search ${unscanned.join(", ")})` : ""}.`;
  return ask(
    next,
    {
      title: "Which instance should run it?",
      body: online
        ? `${account} Only running instances whose SSM agent is online can be used.`
        : `${account} No running instance in any region has an online SSM agent. It needs an instance role with AmazonSSMManagedInstanceCore and outbound internet; then Retry.`,
      fields: [
        {
          id: "instance",
          label: "Instance",
          kind: "choice",
          value: state.instanceId ?? online?.id ?? "",
          options: listed.map((i) => ({
            value: i.id,
            label: i.name || i.id,
            detail: `${i.name ? `${i.id} · ` : ""}${i.region} · ${i.type} · ${i.arch}${i.ssmOnline ? "" : " · SSM agent not online"}`,
            disabled: !i.ssmOnline,
          })),
        },
        { id: "name", label: "Runner name", kind: "text", value: state.name ?? "ec2" },
      ],
      submit: "Continue",
    },
    error,
  );
};

const chooseTarget = (state: AwsState, input: GuideInput, ports: AwsPorts): Promise<GuideResult> | GuideResult => {
  const name = (input.name ?? "").trim();
  const instance = input.instance ?? "";
  const kept: AwsState = { ...state, name };
  const problem =
    nameProblem(name, ports.runnerNames) ??
    (state.found?.[instance] ? null : "Pick an instance.");
  if (problem) return target(kept, ports, problem);
  return working(
    { ...kept, step: "detect", instanceId: instance, region: state.found![instance]!.region },
    "Looking for a runner",
    "Checking the instance…",
  );
};

const detect = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed(state, "Looking for a runner", h.error);
  const sent = await h.value.sendScript(state.instanceId!, detectScript());
  if (!sent.ok) return failed(state, "Looking for a runner", sent.error);
  return working({ ...state, step: "detecting", commandId: sent.value, polls: 0 }, "Looking for a runner", "Checking the instance…");
};

/** The found token reuses the guide's vault key, so retrying never leaves a stray entry. */
const adopt = async (state: AwsState, port: number, token: string, ports: AwsPorts): Promise<GuideResult> => {
  const key = state.tokenKey ?? `runner/${state.name}/${randomUUID()}`;
  const stored = await ports.vault.set(key, token);
  if (!stored.ok) return failed({ ...state, step: "detect" }, "Looking for a runner", stored.error);
  return working({ ...state, step: "check", tokenKey: key, remotePort: port, adopted: true }, "Connecting", "Found a runner; opening the tunnel…");
};

const waitDetect = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed({ ...state, step: "detect" }, "Looking for a runner", h.error);
  const result = await h.value.scriptResult(state.instanceId!, state.commandId!);
  if (!result.ok) return failed({ ...state, step: "detect" }, "Looking for a runner", result.error);
  if (result.value.done) {
    if (!result.value.ok) return failed({ ...state, step: "detect" }, "Looking for a runner", result.value.output.trim().split("\n").slice(-5).join("\n") || "the check script failed");
    const found = parseDetect(result.value.output);
    if (found) return adopt(state, found.port, found.token, ports);
    return working({ ...state, step: "push" }, "Installing the runner", "Copying the runner that npm run build made to the instance…");
  }
  const polls = (state.polls ?? 0) + 1;
  if (polls > MAX_DETECT_POLLS) return failed({ ...state, step: "detect" }, "Looking for a runner", `the check script did not finish in ${(MAX_DETECT_POLLS * POLL_MS) / 60_000} minutes`);
  await ports.sleep(POLL_MS);
  return working({ ...state, polls }, "Looking for a runner", `Checking the instance… (${polls * (POLL_MS / 1000)}s)`);
};

const runnerToken = async (state: AwsState, ports: AwsPorts): Promise<Outcome<{ key: string; token: string }>> => {
  if (state.tokenKey) {
    const existing = await reveal(ports.vault, { kind: "vault", key: state.tokenKey });
    return existing.ok ? ok({ key: state.tokenKey, token: existing.value }) : existing;
  }
  const key = `runner/${state.name}/${randomUUID()}`;
  const token = randomBytes(24).toString("hex");
  const stored = await ports.vault.set(key, token);
  return stored.ok ? ok({ key, token }) : stored;
};

// TEMPORARY: until runner releases are published, the runner installed is the Linux build `npm run build` made, copied over scp (local-build.ts).
const push = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const pushed = await ports.pushLocalBuild(state.instanceId!, state.region!, state.found?.[state.instanceId!]?.arch ?? "arm64", state.credentials!);
  return pushed.ok ? working({ ...state, step: "install" }, "Installing the runner", "Starting…") : failed(state, "Installing the runner", pushed.error);
};

const install = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed(state, "Installing the runner", h.error);
  const token = await runnerToken(state, ports);
  if (!token.ok) return failed(state, "Installing the runner", token.error);
  const withToken: AwsState = { ...state, tokenKey: token.value.key };
  const script = installScript({
    release: LOCAL_RELEASE_DIR,
    arch: state.found?.[state.instanceId!]?.arch ?? "arm64",
    token: token.value.token,
    name: state.name!,
    region: state.region!,
    port: RUNNER_PORT,
  });
  const sent = await h.value.sendScript(state.instanceId!, script);
  if (!sent.ok) return failed(withToken, "Installing the runner", sent.error);
  return working({ ...withToken, step: "installing", commandId: sent.value, polls: 0 }, "Installing the runner", "Downloading the runner…");
};

const waitInstall = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
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
    summary: `EC2 ${state.instanceId} · ${state.region}${state.adopted ? " · existing runner" : ""}`,
    teardown: { label: `uninstall the runner and its agents from ${state.instanceId}`, data: { instanceId: state.instanceId!, region: state.region! } },
  },
});

/** Opens the same tunnel the Controller will use from now on, and asks the runner for its agents. */
const check = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  try {
    const link = await ports.transports(transportOf(state)).open(abort.signal);
    if (!link.ok) return failed(state, "Connecting", link.error);
    const res = await ports.fetch(`${link.value.url}/agents`, { signal: abort.signal }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (typeof res === "string") return failed(state, "Connecting", res);
    if (!res.ok) return failed(state, "Connecting", `the runner answered HTTP ${res.status}`);
    return working({ ...state, step: "bedrock" }, "Checking Bedrock", probing);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
};

const bedrock = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed(state, "Checking Bedrock", h.error);
  const sent = await h.value.sendScript(state.instanceId!, bedrockScript([BEDROCK_PROBE_MODEL], state.region!));
  if (!sent.ok) return failed(state, "Checking Bedrock", sent.error);
  return working({ ...state, step: "bedrocking", commandId: sent.value, polls: 0 }, "Checking Bedrock", probing);
};


/** Agents call Bedrock with the instance role, so a role that can't reach the cheapest model fails the set-up. */
const waitBedrock = async (state: AwsState, ports: AwsPorts): Promise<GuideResult> => {
  const h = await host(state, ports);
  if (!h.ok) return failed({ ...state, step: "bedrock" }, "Checking Bedrock", h.error);
  const result = await h.value.scriptResult(state.instanceId!, state.commandId!);
  if (!result.ok) return failed({ ...state, step: "bedrock" }, "Checking Bedrock", result.error);
  if (result.value.done) {
    if (!result.value.ok) return failed({ ...state, step: "bedrock" }, "Checking Bedrock", result.value.output.trim().split("\n").slice(-5).join("\n") || "the Bedrock check failed");
    const { usable, refused } = parseBedrock(result.value.output);
    if (!usable.includes(BEDROCK_PROBE_MODEL)) {
      const why = refused.find((r) => r.model === BEDROCK_PROBE_MODEL)?.reason ?? "no answer";
      return failed(
        { ...state, step: "bedrock" },
        "Checking Bedrock",
        `The instance can't call Bedrock: ${modelLabel(BEDROCK_PROBE_MODEL)} answered ${why}. Allow bedrock:InvokeModel on the instance role for ${BEDROCK_PROBE_MODEL} and the models your agents will use, then Retry.`,
      );
    }
    return { kind: "done", runner: done(state) };
  }
  const polls = (state.polls ?? 0) + 1;
  if (polls > MAX_DETECT_POLLS) return failed({ ...state, step: "bedrock" }, "Checking Bedrock", "the Bedrock check did not finish in 2 minutes");
  await ports.sleep(POLL_MS);
  return working({ ...state, polls }, "Checking Bedrock", `${probing} (${polls * (POLL_MS / 1000)}s)`);
};

/** The guide before its AWS ports are bound; tests drive it with fakes. */
type AwsSteps = Omit<RunnerGuide, "step" | "teardown"> & {
  step(state: GuideState, input: GuideInput | null, ports: AwsPorts): Promise<GuideResult>;
  teardown(runner: NewRunner, ports: AwsPorts): Promise<Outcome<string>>;
};

export const awsSteps: AwsSteps = {
  id: "aws",
  title: "AWS EC2",
  description: "Use the runner on one of your running EC2 instances, installing it if needed, and reach it through an SSM tunnel.",
  start: () => toState({ step: "credentials" }),

  step: async (raw, input, ports) => {
    const state = asState(raw);
    switch (state.step) {
      case "credentials": {
        if (!input) return ask(state, await credentialsView(ports));
        const source = fromSource(input.source ?? "default");
        const homeRegion = await homeRegionOf(source, ports);
        if (source === "keys") return ask({ step: "keys", homeRegion }, keysView);
        return target({ step: "target", homeRegion, credentials: source }, ports);
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
      case "detect":
        return detect(state, ports);
      case "detecting":
        return waitDetect(state, ports);
      case "push":
        return push(state, ports);
      case "install":
        return install(state, ports);
      case "installing":
        return waitInstall(state, ports);
      case "check":
        return check(state, ports);
      case "bedrock":
        return bedrock(state, ports);
      case "bedrocking":
        return waitBedrock(state, ports);
    }
  },

  /** Uninstalls the runner and every agent on the instance; the instance itself is never terminated. */
  teardown: async (runner, ports) => {
    const t = runner.transport;
    if (t.kind !== "aws_ssm") return fail("this runner has no AWS instance to tear down");
    const h = await ports.aws.host(t.credentials, t.region);
    if (!h.ok) return h;
    const sent = await h.value.sendScript(t.instanceId, uninstallScript());
    return sent.ok ? ok(`uninstalling the runner and its agents from ${t.instanceId}; the instance was not terminated`) : sent;
  },
};

export const createAwsGuide = (deps: AwsGuideDeps): RunnerGuide => ({
  ...awsSteps,
  step: (state, input, ports) => awsSteps.step(state, input, { ...ports, ...deps }),
  teardown: (runner, ports) => awsSteps.teardown(runner, { ...ports, ...deps }),
});
