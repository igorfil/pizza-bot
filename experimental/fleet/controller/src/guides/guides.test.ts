import { describe, expect, test } from "vitest";
import { ok, fail } from "../outcome.js";
import type { Transport } from "../transport.js";
import type { GuideResult, GuideState } from "../types.js";
import { memoryVault } from "../vault.js";
import { awsGuide } from "./aws/guide.js";
import type { AwsPort, Ec2Host, Instance } from "./aws/port.js";
import type { GuidePorts } from "./guide.js";
import { manualGuide } from "./manual.js";
import { catalog } from "./registry.js";

const instances: Instance[] = [
  { id: "i-online", name: "box", type: "t4g.small", arch: "arm64", ssmOnline: true },
  { id: "i-offline", name: "", type: "t3.micro", arch: "x86_64", ssmOnline: false },
];

const fakeHost = (over: Partial<Ec2Host> = {}): Ec2Host => ({
  whoAmI: async () => ok({ account: "123", arn: "arn:aws:iam::123:user/me" }),
  canUseEc2: async () => ok(undefined),
  regions: async () => ok(["eu-west-1"]),
  instances: async () => ok(instances),
  sendScript: async () => ok("cmd-1"),
  scriptResult: async () => ok({ done: true, ok: true, output: "" }),
  ...over,
});

const BEDROCK_OK = "FLEET_BEDROCK us.amazon.nova-micro-v1:0 ok\n";

/** The Bedrock check gets `bedrock` as its output; every other script goes to the host as given. */
const withBedrock = (host: Ec2Host, bedrock: string): Ec2Host => ({
  ...host,
  sendScript: async (id, script) => (script.includes("FLEET_BEDROCK") ? ok("bedrock-check") : host.sendScript(id, script)),
  scriptResult: async (id, cmd) => (cmd === "bedrock-check" ? ok({ done: true, ok: true, output: bedrock }) : host.scriptResult(id, cmd)),
});

/** One host for every region, or one per region; `calls` records the region of every host asked for. */
const fakeAws = (
  host: Ec2Host | ((region: string) => Ec2Host) = fakeHost(),
  profiles: { name: string; region: string | null }[] = [{ name: "default", region: "eu-west-1" }],
  calls: string[] = [],
  bedrock = BEDROCK_OK,
): AwsPort => ({
  profiles: async () => profiles,
  host: async (_creds, region) => (calls.push(region), ok(withBedrock(typeof host === "function" ? host(region) : host, bedrock))),
});

const upTransport: Transport = { open: async () => ok({ url: "http://127.0.0.1:5555", closed: new Promise(() => {}) }) };

const ports = (over: Partial<GuidePorts> = {}): GuidePorts => ({
  sessionId: "s1",
  runnerNames: ["laptop"],
  vault: memoryVault(),
  aws: fakeAws(),
  transports: () => upTransport,
  fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  sleep: async () => {},
  pushLocalBuild: async () => ok(undefined),
  ...over,
});

/** Runs `working` steps until the guide asks, fails or finishes. */
const settle = async (result: GuideResult, p: GuidePorts, guide = awsGuide): Promise<GuideResult> =>
  result.kind === "working" ? settle(await guide.step(result.state, null, p), p, guide) : result;

const answer = async (state: GuideState, input: Record<string, string>, p: GuidePorts) => settle(await awsGuide.step(state, input, p), p);

const stateOf = (r: GuideResult): GuideState => ("state" in r ? r.state : {});

const isInstall = (script: string) => script.includes("fleet-runner.service");
const installs = (scripts: string[]) => scripts.filter(isInstall);

/** A host where only the install script ends with `result`; the runner check finds nothing. */
const failingInstall = (result: { done: boolean; ok: boolean; output: string }, scripts: string[] = []) =>
  fakeHost({
    sendScript: async (_id, s) => (scripts.push(s), ok(isInstall(s) ? "install" : "detect")),
    scriptResult: async (_id, cmd) => ok(cmd === "install" ? result : { done: true, ok: true, output: "FLEET_RUNNER=absent" }),
  });

const toTarget = async (p: GuidePorts) => answer(stateOf(await awsGuide.step(awsGuide.start(), null, p)), { source: "profile:default" }, p);

describe("manual guide", () => {
  test("is listed as coming soon", () => {
    expect(catalog([manualGuide])).toEqual([{ id: "manual", title: "By URL", description: manualGuide.description, comingSoon: true }]);
  });

  test("has no workflow yet", async () => {
    const r = await manualGuide.step({}, null, ports());
    expect([r.kind, r.kind === "failed" && r.error]).toEqual(["failed", "Adding a runner by URL isn't available yet."]);
  });
});

describe("aws guide: credentials", () => {
  test("offers the profiles from the AWS config, the default chain and access keys", async () => {
    const r = await awsGuide.step(awsGuide.start(), null, ports());
    const source = r.kind === "ask" ? r.view.fields.find((f) => f.id === "source") : undefined;
    expect(source?.options?.map((o) => o.value)).toEqual(["profile:default", "default", "keys"]);
  });

  test("asks only how to sign in, not for a region", async () => {
    const r = await awsGuide.step(awsGuide.start(), null, ports());
    expect(r.kind === "ask" && r.view.fields.map((f) => f.id)).toEqual(["source"]);
  });

  test("account-wide calls go to the profile's region", async () => {
    const calls: string[] = [];
    const multi = fakeHost({ regions: async () => ok(["ap-south-1", "eu-west-1"]) });
    await toTarget(ports({ aws: fakeAws(multi, [{ name: "default", region: "eu-west-1" }], calls) }));
    expect(calls[0]).toBe("eu-west-1");
  });

  test("account-wide calls go to us-east-1 when the profile names no region", async () => {
    const calls: string[] = [];
    await toTarget(ports({ aws: fakeAws(fakeHost(), [{ name: "default", region: null }], calls) }));
    expect(calls[0]).toBe("us-east-1");
  });

  test("choosing access keys asks for them as secrets", async () => {
    const r = await awsGuide.step(awsGuide.start(), { source: "keys" }, ports());
    expect(r.kind === "ask" && r.view.fields.map((f) => f.kind)).toEqual(["secret", "secret"]);
  });

  test("entered keys are kept only as vault references", async () => {
    const keys = await awsGuide.step(awsGuide.start(), { source: "keys" }, ports());
    const r = await awsGuide.step(stateOf(keys), { accessKeyId: "guide/s1/a/1", secretAccessKey: "guide/s1/b/2" }, ports());
    expect(stateOf(r).credentials).toEqual({
      kind: "keys",
      accessKeyId: { kind: "vault", key: "guide/s1/a/1" },
      secretAccessKey: { kind: "vault", key: "guide/s1/b/2" },
    });
  });

  test("credentials that don't work fail with the reason", async () => {
    const p = ports({ aws: fakeAws(fakeHost({ whoAmI: async () => fail("ExpiredToken") })) });
    const r = await toTarget(p);
    expect([r.kind, r.kind === "failed" && r.error]).toEqual(["failed", "ExpiredToken"]);
  });

  test("no EC2 permission fails with the reason", async () => {
    const p = ports({ aws: fakeAws(fakeHost({ canUseEc2: async () => fail("EC2 access denied: UnauthorizedOperation") })) });
    expect(await toTarget(p)).toMatchObject({ kind: "failed", error: "EC2 access denied: UnauthorizedOperation" });
  });
});

describe("aws guide: target", () => {
  test("lists running instances and disables those without SSM; launching is not offered", async () => {
    const r = await toTarget(ports());
    const field = r.kind === "ask" ? r.view.fields.find((f) => f.id === "instance") : undefined;
    expect(field?.options?.map((o) => [o.value, o.disabled ?? false])).toEqual([
      ["i-online", false],
      ["i-offline", true],
    ]);
  });

  test("explains what an instance needs when none has SSM online", async () => {
    const p = ports({ aws: fakeAws(fakeHost({ instances: async () => ok([instances[1]!]) })) });
    const r = await toTarget(p);
    expect(r.kind === "ask" && r.view.body).toContain("AmazonSSMManagedInstanceCore");
  });

  test("an instance that can't be used is refused", async () => {
    const p = ports();
    const r = await answer(stateOf(await toTarget(p)), { instance: "i-unknown", name: "ec2" }, p);
    expect(r.kind === "ask" && r.error).toBe("Pick an instance.");
  });

  test("shows which account it is using", async () => {
    const r = await toTarget(ports());
    expect(r.kind === "ask" && r.view.body).toContain("Account 123");
  });

  test("an instance is titled by its name, with its id in the details", async () => {
    const r = await toTarget(ports());
    const option = r.kind === "ask" ? r.view.fields.find((f) => f.id === "instance")?.options?.[0] : undefined;
    expect([option?.label, option?.detail?.startsWith("i-online · ")]).toEqual(["box", true]);
  });

  test("an invalid runner name asks again", async () => {
    const p = ports();
    const r = await answer(stateOf(await toTarget(p)), { instance: "i-online", name: "Bad Name" }, p);
    expect(r.kind === "ask" && r.error).toBe("Use lowercase letters, digits and dashes, starting with a letter.");
  });
});

describe("aws guide: searching every region", () => {
  const box = (id: string, ssmOnline: boolean): Instance => ({ id, name: "", type: "t4g.small", arch: "arm64", ssmOnline });
  const perRegion: Record<string, Instance[]> = { "eu-west-1": [box("i-eu", false)], "us-east-2": [], "us-west-2": [box("i-us", true)] };
  const world = (fails: string[] = []) =>
    fakeAws((region) =>
      fakeHost({
        regions: async () => ok(Object.keys(perRegion)),
        instances: async () => (fails.includes(region) ? fail(`denied in ${region}`) : ok(perRegion[region] ?? [])),
      }),
    );

  test("lists instances from every region, usable ones first, each with its region", async () => {
    const r = await toTarget(ports({ aws: world() }));
    const field = r.kind === "ask" ? r.view.fields.find((f) => f.id === "instance") : undefined;
    expect(field?.options?.map((o) => [o.value, o.detail?.split(" · ")[0]])).toEqual([
      ["i-us", "us-west-2"],
      ["i-eu", "eu-west-1"],
    ]);
  });

  test("the runner is reached in the region of the instance picked", async () => {
    const p = ports({ aws: world() });
    const r = await answer(stateOf(await toTarget(p)), { instance: "i-us", name: "ec2" }, p);
    expect(r.kind === "done" && r.runner.transport.kind === "aws_ssm" && r.runner.transport.region).toBe("us-west-2");
  });

  test("a region that can't be searched is skipped and named", async () => {
    const r = await toTarget(ports({ aws: world(["eu-west-1"]) }));
    expect([r.kind, r.kind === "ask" && r.view.body?.includes("2 regions searched (could not search eu-west-1)")]).toEqual(["ask", true]);
  });

  test("fails when no region can be searched", async () => {
    const r = await toTarget(ports({ aws: world(Object.keys(perRegion)) }));
    expect(r.kind === "failed" && r.error).toBe("no region could be searched (eu-west-1, us-east-2, us-west-2)");
  });
});

describe("aws guide: existing instance", () => {
  const pick = { instance: "i-online", name: "ec2" };

  test("installs over SSM, checks through the tunnel, and finishes with an aws_ssm runner", async () => {
    const p = ports();
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect(r.kind === "done" && { ...r.runner, token: r.runner.token.kind }).toEqual({
      name: "ec2",
      transport: { kind: "aws_ssm", region: "eu-west-1", instanceId: "i-online", remotePort: 9000, credentials: { kind: "profile", profile: "default" } },
      token: "vault",
      origin: {
        guide: "aws",
        summary: "EC2 i-online · eu-west-1",
        teardown: { label: "uninstall the runner and its agents from i-online", data: { instanceId: "i-online", region: "eu-west-1" } },
      },
    });
  });

  test("the generated runner token is in the vault and in the install script, never in the state", async () => {
    const vault = memoryVault();
    const scripts: string[] = [];
    const p = ports({ vault, aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")) })) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    const token = r.kind === "done" && r.runner.token.kind === "vault" ? await vault.get(r.runner.token.key) : null;
    const value = token?.ok ? (token.value ?? "?") : "?";
    expect([/^[0-9a-f]{48}$/.test(value), installs(scripts)[0]?.includes(`RUNNER_TOKEN=${value}`)]).toEqual([true, true]);
  });

  test("the install script downloads the binary for the instance's architecture", async () => {
    const scripts: string[] = [];
    const p = ports({ aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")) })) });
    await answer(stateOf(await toTarget(p)), pick, p);
    expect(installs(scripts)[0]).toContain('"$RELEASE/fleet-runner-aarch64-linux-musl"');
  });

  test("waits while the install script runs", async () => {
    let polls = 0;
    const host = fakeHost({
      sendScript: async (_id, s) => ok(s.includes("fleet-runner.service") ? "install" : "detect"),
      scriptResult: async (_id, cmd) => ok({ done: cmd === "detect" || ++polls > 2, ok: true, output: "" }),
    });
    const p = ports({ aws: fakeAws(host) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, polls]).toEqual(["done", 3]);
  });

  test("a failed install shows the end of its output and retries from install", async () => {
    const p = ports({ aws: fakeAws(failingInstall({ done: true, ok: false, output: "a\nb\ncurl: (22) 404" })) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "failed" && r.error.endsWith("curl: (22) 404"), stateOf(r).step]).toEqual(["failed", true, "install"]);
  });

  test("retrying an install reuses the runner token", async () => {
    const vault = memoryVault();
    const scripts: string[] = [];
    const p = ports({ vault, aws: fakeAws(failingInstall({ done: true, ok: false, output: "x" }, scripts)) });
    const firstTry = await answer(stateOf(await toTarget(p)), pick, p);
    await settle(await awsGuide.step(stateOf(firstTry), null, p), p);
    const token = (s: string) => /RUNNER_TOKEN=(\w+)/.exec(s)?.[1];
    expect(token(installs(scripts)[0]!)).toBe(token(installs(scripts)[1]!));
  });


  test("a tunnel that won't open fails at the check, and Retry checks again", async () => {
    const down: Transport = { open: async () => fail("SessionManagerPlugin is not found") };
    const p = ports({ transports: () => down });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "failed" && r.error, stateOf(r).step]).toEqual(["failed", "SessionManagerPlugin is not found", "check"]);
  });
});

describe("aws guide: instance that already runs a runner", () => {
  const pick = { instance: "i-online", name: "ec2" };
  const found = "FLEET_RUNNER=present\nFLEET_RUNNER_PORT=9100\nFLEET_RUNNER_TOKEN=abc123\n";
  const existing = (scripts: string[] = [], output = found) =>
    fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")), scriptResult: async () => ok({ done: true, ok: true, output }) });

  test("adopts it without installing, through a tunnel to its port", async () => {
    const scripts: string[] = [];
    const p = ports({ aws: fakeAws(existing(scripts)) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "done" && r.runner.transport, installs(scripts).length]).toEqual([
      "done",
      { kind: "aws_ssm", region: "eu-west-1", instanceId: "i-online", remotePort: 9100, credentials: { kind: "profile", profile: "default" } },
      0,
    ]);
  });

  test("keeps the runner's own token in the vault and out of the guide state", async () => {
    const vault = memoryVault();
    const p = ports({ vault, aws: fakeAws(existing()) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    const token = r.kind === "done" && r.runner.token.kind === "vault" ? await vault.get(r.runner.token.key) : null;
    expect([token, JSON.stringify(stateOf(r)).includes("abc123")]).toEqual([{ ok: true, value: "abc123" }, false]);
  });

  test("removing an adopted runner uninstalls it and its agents too", async () => {
    const p = ports({ aws: fakeAws(existing()) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect(r.kind === "done" && r.runner.origin?.teardown?.label).toBe("uninstall the runner and its agents from i-online");
  });

  test("installs when the check finds no runner", async () => {
    const scripts: string[] = [];
    const p = ports({ aws: fakeAws(existing(scripts, "FLEET_RUNNER=absent\n")) });
    await answer(stateOf(await toTarget(p)), pick, p);
    expect(installs(scripts).length).toBe(1);
  });

  test("a check script that fails is reported, and Retry checks again", async () => {
    const host = fakeHost({ scriptResult: async () => ok({ done: true, ok: false, output: "bash: curl: command not found" }) });
    const p = ports({ aws: fakeAws(host) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "failed" && r.error, stateOf(r).step]).toEqual(["failed", "bash: curl: command not found", "detect"]);
  });
});

describe("aws guide: steps", () => {
  test("credentials are step 1 of Sign in, Pick instance, Set up", async () => {
    const r = await awsGuide.step(awsGuide.start(), null, ports());
    expect(r.kind === "ask" && r.view.steps).toEqual({ labels: ["Sign in", "Pick instance", "Set up"], current: 0 });
  });

  test("the instance list is step 2 and asks only for the instance and a name", async () => {
    const r = await toTarget(ports());
    expect([r.kind === "ask" && r.view.steps?.current, r.kind === "ask" && r.view.fields.map((f) => f.id)]).toEqual([1, ["instance", "name"]]);
  });

  test("installing is step 3", async () => {
    const p = ports();
    const r = await awsGuide.step(stateOf(await toTarget(p)), { instance: "i-online", name: "ec2" }, p);
    expect(r.kind === "working" && r.view.steps?.current).toBe(2);
  });

  test("a new runner serves no agents until some are added", async () => {
    const scripts: string[] = [];
    const p = ports({ aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")) })) });
    await answer(stateOf(await toTarget(p)), { instance: "i-online", name: "ec2" }, p);
    expect(installs(scripts)[0]).toMatch(/^RUNNER_AGENTS=$/m);
  });
});

describe("aws guide: local build (temporary)", () => {
  const pick = { instance: "i-online", name: "ec2" };

  test("copies the local build to the picked instance, then installs it from there", async () => {
    const pushes: string[][] = [];
    const scripts: string[] = [];
    const p = ports({
      pushLocalBuild: async (id, region, arch) => (pushes.push([id, region, arch]), ok(undefined)),
      aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")) })),
    });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, pushes, installs(scripts)[0]?.includes("RELEASE='file:///tmp/fleet-local'")]).toEqual(["done", [["i-online", "eu-west-1", "arm64"]], true]);
  });

  test("a failed copy shows why and Retry copies again", async () => {
    const p = ports({ pushLocalBuild: async () => fail("zig is missing: brew install zig") });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "failed" && r.error, stateOf(r).step]).toEqual(["failed", "zig is missing: brew install zig", "push"]);
  });

  test("an instance that already runs a runner is adopted without copying anything", async () => {
    const pushes: string[] = [];
    const found = "FLEET_RUNNER=present\nFLEET_RUNNER_PORT=9000\nFLEET_RUNNER_TOKEN=abc\n";
    const p = ports({
      pushLocalBuild: async (id) => (pushes.push(id), ok(undefined)),
      aws: fakeAws(fakeHost({ scriptResult: async () => ok({ done: true, ok: true, output: found }) })),
    });
    await answer(stateOf(await toTarget(p)), pick, p);
    expect(pushes).toEqual([]);
  });
});

describe("aws guide: set-up checklist", () => {
  const pick = { instance: "i-online", name: "ec2" };

  /** Every screen the guide shows from picking the instance until it finishes. */
  const screens = async (p: GuidePorts): Promise<GuideResult[]> => {
    const seen: GuideResult[] = [];
    const walk = async (r: GuideResult): Promise<void> => {
      seen.push(r);
      if (r.kind === "working") await walk(await awsGuide.step(r.state, null, p));
    };
    await walk(await awsGuide.step(stateOf(await toTarget(p)), pick, p));
    return seen;
  };
  const marks = (r: GuideResult) => (r.kind === "working" || r.kind === "failed" ? (r.view.checklist ?? []).map((i) => `${i.label}:${i.state}`) : []);

  test("lists every set-up step and works through them in order", async () => {
    const seen = await screens(ports());
    expect(seen.filter((r) => r.kind === "working").map((r) => marks(r).find((m) => m.endsWith(":current")))).toEqual([
      "Connect to the instance:current",
      "Connect to the instance:current",
      "Copy the local build:current",
      "Install the runner:current",
      "Install the runner:current",
      "Open the tunnel to the runner:current",
      "Verify Bedrock access:current",
      "Verify Bedrock access:current",
    ]);
  });

  test("checks off the steps before the current one", async () => {
    const seen = await screens(ports());
    const atBedrock = seen.find((r) => marks(r).includes("Verify Bedrock access:current"))!;
    expect(marks(atBedrock)).toEqual(["Connect to the instance:done", "Copy the local build:done", "Install the runner:done", "Open the tunnel to the runner:done", "Verify Bedrock access:current"]);
  });

  test("shows the current step's progress under it", async () => {
    const seen = await screens(ports());
    const installing = seen.find((r) => r.kind === "working" && r.view.checklist?.some((i) => i.state === "current" && i.label === "Install the runner"));
    expect(installing?.kind === "working" && installing.view.checklist?.find((i) => i.state === "current")?.detail).toBe("Starting…");
  });

  test("an adopted runner skips installing", async () => {
    const found = "FLEET_RUNNER=present\nFLEET_RUNNER_PORT=9000\nFLEET_RUNNER_TOKEN=abc\n";
    const seen = await screens(ports({ aws: fakeAws(fakeHost({ scriptResult: async () => ok({ done: true, ok: true, output: found }) })) }));
    expect(marks(seen.find((r) => marks(r).includes("Open the tunnel to the runner:current"))!)).toContain("Install the runner:skipped");
  });

  test("starts with every step to do, the local build copy included", async () => {
    const seen = await screens(ports());
    expect(marks(seen[0]!)).toEqual(["Connect to the instance:current", "Copy the local build:pending", "Install the runner:pending", "Open the tunnel to the runner:pending", "Verify Bedrock access:pending"]);
  });

  test("a failed step is marked on the checklist", async () => {
    const down: Transport = { open: async () => fail("SessionManagerPlugin is not found") };
    const seen = await screens(ports({ transports: () => down }));
    expect(marks(seen.at(-1)!)).toContain("Open the tunnel to the runner:failed");
  });

  test("checks Bedrock with one call to the cheapest model", async () => {
    const scripts: string[] = [];
    const host = fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")) });
    const p = ports({ aws: { profiles: async () => [{ name: "default", region: "eu-west-1" }], host: async () => ok(host) } });
    const atBedrock = (await screens(p)).find((r) => marks(r).includes("Verify Bedrock access:current"))!;
    await awsGuide.step(stateOf(atBedrock), null, p);
    expect(scripts.at(-1)).toContain('for model in ["us.amazon.nova-micro-v1:0"]:');
  });

  test("an instance role that can't reach Bedrock fails the set-up with how to fix it", async () => {
    const denied = "FLEET_BEDROCK us.amazon.nova-micro-v1:0 AccessDeniedException\n";
    const seen = await screens(ports({ aws: fakeAws(fakeHost(), undefined, undefined, denied) }));
    const last = seen.at(-1)!;
    expect([last.kind, last.kind === "failed" && last.error, marks(last).at(-1)]).toEqual([
      "failed",
      "The instance can't call Bedrock: Amazon Nova Micro answered AccessDeniedException. Allow bedrock:InvokeModel on the instance role for us.amazon.nova-micro-v1:0 and the models your agents will use, then Retry.",
      "Verify Bedrock access:failed",
    ]);
  });
});

describe("aws guide: teardown", () => {
  const runner = () => ({
    name: "ec2",
    transport: { kind: "aws_ssm" as const, region: "eu-west-1", instanceId: "i-1", remotePort: 9000, credentials: { kind: "default" as const } },
    token: { kind: "vault" as const, key: "k" },
    origin: { guide: "aws", summary: "", teardown: { label: "", data: { instanceId: "i-1", region: "eu-west-1" } } },
  });

  test("uninstalls the runner and leaves the instance running", async () => {
    const scripts: string[] = [];
    await awsGuide.teardown!(runner(), ports({ aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("c")) })) }));
    expect(scripts[0]).toContain("systemctl disable --now fleet-runner");
  });

  test("deletes every agent on the instance, created ones included", async () => {
    const scripts: string[] = [];
    await awsGuide.teardown!(runner(), ports({ aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("c")) })) }));
    expect([scripts[0]?.includes("rm -rf /opt/fleet-agents"), scripts[0]?.includes("rm -rf /var/lib/fleet-runner")]).toEqual([true, true]);
  });

  test("says the instance was not terminated", async () => {
    const r = await awsGuide.teardown!(runner(), ports());
    expect(r).toEqual({ ok: true, value: "uninstalling the runner and its agents from i-1; the instance was not terminated" });
  });

  test("works for a runner adopted before removal could uninstall, from its transport", async () => {
    const scripts: string[] = [];
    const adopted = { ...runner(), origin: { guide: "aws", summary: "", teardown: null } };
    await awsGuide.teardown!(adopted, ports({ aws: fakeAws(fakeHost({ sendScript: async (id, s) => (scripts.push(`${id}:${s.slice(0, 11)}`), ok("c")) })) }));
    expect(scripts).toEqual(["i-1:#!/bin/bash"]);
  });
});
