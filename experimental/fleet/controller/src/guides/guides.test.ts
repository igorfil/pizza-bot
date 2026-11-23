import { describe, expect, test } from "vitest";
import { ok, fail } from "../outcome.js";
import type { Transport } from "../transport.js";
import type { GuideResult, GuideState } from "../types.js";
import { memoryVault } from "../vault.js";
import { awsGuide } from "./aws/guide.js";
import type { AwsPort, Ec2Host, Instance } from "./aws/port.js";
import type { GuidePorts } from "./guide.js";
import { manualGuide } from "./manual.js";

const instances: Instance[] = [
  { id: "i-online", name: "box", type: "t4g.small", arch: "arm64", ssmOnline: true },
  { id: "i-offline", name: "", type: "t3.micro", arch: "x86_64", ssmOnline: false },
];

const fakeHost = (over: Partial<Ec2Host> = {}): Ec2Host => ({
  whoAmI: async () => ok({ account: "123", arn: "arn:aws:iam::123:user/me" }),
  canUseEc2: async () => ok(undefined),
  instances: async () => ok(instances),
  sendScript: async () => ok("cmd-1"),
  scriptResult: async () => ok({ done: true, ok: true, output: "" }),
  ...over,
});

const fakeAws = (host: Ec2Host = fakeHost(), profiles = [{ name: "default", region: "eu-west-1" }]): AwsPort => ({
  profiles: async () => profiles,
  host: async () => ok(host),
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
  release: "https://github.com/o/r/releases/download/fleet-runner-v1",
  ...over,
});

/** Runs `working` steps until the guide asks, fails or finishes. */
const settle = async (result: GuideResult, p: GuidePorts, guide = awsGuide): Promise<GuideResult> =>
  result.kind === "working" ? settle(await guide.step(result.state, null, p), p, guide) : result;

const answer = async (state: GuideState, input: Record<string, string>, p: GuidePorts) => settle(await awsGuide.step(state, input, p), p);

const stateOf = (r: GuideResult): GuideState => ("state" in r ? r.state : {});

const toTarget = async (p: GuidePorts) => answer(stateOf(await awsGuide.step(awsGuide.start(), null, p)), { source: "profile:default", region: "eu-west-1" }, p);

describe("manual guide", () => {
  test("asks for name, URL and token", async () => {
    const r = await manualGuide.step({}, null, ports());
    expect(r.kind === "ask" && r.view.fields.map((f) => [f.id, f.kind])).toEqual([
      ["name", "text"],
      ["url", "text"],
      ["token", "secret"],
    ]);
  });

  test("a valid answer becomes a direct runner holding the vault key", async () => {
    const r = await manualGuide.step({}, { name: "home", url: "http://h:9301/", token: "guide/s1/token/k" }, ports());
    expect(r.kind === "done" && r.runner).toEqual({
      name: "home",
      transport: { kind: "direct", url: "http://h:9301" },
      token: { kind: "vault", key: "guide/s1/token/k" },
      origin: { guide: "manual", summary: "http://h:9301", teardown: null },
    });
  });

  test("a taken name asks again and keeps what was typed", async () => {
    const r = await manualGuide.step({}, { name: "laptop", url: "http://h", token: "k" }, ports());
    expect([r.kind, r.kind === "ask" && r.error, r.kind === "ask" && r.view.fields[1]?.value]).toEqual(["ask", "A runner named laptop already exists.", "http://h"]);
  });

  test("a URL without a scheme is refused", async () => {
    const r = await manualGuide.step({}, { name: "home", url: "h:9301", token: "k" }, ports());
    expect(r.kind === "ask" && r.error).toBe("The URL must start with http:// or https://.");
  });
});

describe("aws guide: credentials", () => {
  test("offers the profiles from the AWS config, the default chain and access keys", async () => {
    const r = await awsGuide.step(awsGuide.start(), null, ports());
    const source = r.kind === "ask" ? r.view.fields.find((f) => f.id === "source") : undefined;
    expect(source?.options?.map((o) => o.value)).toEqual(["profile:default", "default", "keys"]);
  });

  test("the region defaults to the profile's", async () => {
    const r = await awsGuide.step(awsGuide.start(), null, ports());
    expect(r.kind === "ask" && r.view.fields.find((f) => f.id === "region")?.value).toBe("eu-west-1");
  });

  test("a bad region asks again", async () => {
    const r = await awsGuide.step(awsGuide.start(), { source: "default", region: "mars" }, ports());
    expect(r.kind === "ask" && r.error).toBe("Enter a region like us-west-2.");
  });

  test("choosing access keys asks for them as secrets", async () => {
    const r = await awsGuide.step(awsGuide.start(), { source: "keys", region: "us-west-2" }, ports());
    expect(r.kind === "ask" && r.view.fields.map((f) => f.kind)).toEqual(["secret", "secret"]);
  });

  test("entered keys are kept only as vault references", async () => {
    const keys = await awsGuide.step(awsGuide.start(), { source: "keys", region: "us-west-2" }, ports());
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
    const r = await answer(stateOf(await toTarget(p)), { instance: "i-unknown", name: "ec2", agents: "dadjokes" }, p);
    expect(r.kind === "ask" && r.error).toBe("Pick an instance.");
  });

  test("shows which account it is using", async () => {
    const r = await toTarget(ports());
    expect(r.kind === "ask" && r.view.body).toContain("Account 123");
  });

  test("an invalid runner name asks again", async () => {
    const p = ports();
    const r = await answer(stateOf(await toTarget(p)), { instance: "i-online", name: "Bad Name", agents: "dadjokes" }, p);
    expect(r.kind === "ask" && r.error).toBe("Use lowercase letters, digits and dashes, starting with a letter.");
  });
});

describe("aws guide: existing instance", () => {
  const pick = { instance: "i-online", name: "ec2", agents: "dadjokes" };

  test("installs over SSM, checks through the tunnel, and finishes with an aws-ssm runner", async () => {
    const p = ports();
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect(r.kind === "done" && { ...r.runner, token: r.runner.token.kind }).toEqual({
      name: "ec2",
      transport: { kind: "aws-ssm", region: "eu-west-1", instanceId: "i-online", remotePort: 9000, credentials: { kind: "profile", profile: "default" } },
      token: "vault",
      origin: {
        guide: "aws",
        summary: "EC2 i-online · eu-west-1",
        teardown: { label: "uninstall the runner from i-online", data: { instanceId: "i-online", region: "eu-west-1" } },
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
    expect([/^[0-9a-f]{48}$/.test(value), scripts[0]?.includes(`RUNNER_TOKEN=${value}`)]).toEqual([true, true]);
  });

  test("the install script downloads the binary for the instance's architecture", async () => {
    const scripts: string[] = [];
    const p = ports({ aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")) })) });
    await answer(stateOf(await toTarget(p)), pick, p);
    expect(scripts[0]).toContain('"$RELEASE/fleet-runner-aarch64-linux-musl"');
  });

  test("waits while the install script runs", async () => {
    let polls = 0;
    const p = ports({ aws: fakeAws(fakeHost({ scriptResult: async () => ok({ done: ++polls > 2, ok: true, output: "" }) })) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, polls]).toEqual(["done", 3]);
  });

  test("a failed install shows the end of its output and retries from install", async () => {
    const p = ports({ aws: fakeAws(fakeHost({ scriptResult: async () => ok({ done: true, ok: false, output: "a\nb\ncurl: (22) 404" }) })) });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "failed" && r.error.endsWith("curl: (22) 404"), stateOf(r).step]).toEqual(["failed", true, "install"]);
  });

  test("retrying an install reuses the runner token", async () => {
    const vault = memoryVault();
    const scripts: string[] = [];
    const host = fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("cmd")), scriptResult: async () => ok({ done: true, ok: false, output: "x" }) });
    const p = ports({ vault, aws: fakeAws(host) });
    const firstTry = await answer(stateOf(await toTarget(p)), pick, p);
    await settle(await awsGuide.step(stateOf(firstTry), null, p), p);
    const token = (s: string) => /RUNNER_TOKEN=(\w+)/.exec(s)?.[1];
    expect(token(scripts[0]!)).toBe(token(scripts[1]!));
  });

  test("no release configured fails with what to set", async () => {
    const p = ports({ release: "" });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect(r.kind === "failed" && r.error).toContain("FLEET_RUNNER_RELEASE");
  });

  test("a tunnel that won't open fails at the check, and Retry checks again", async () => {
    const down: Transport = { open: async () => fail("SessionManagerPlugin is not found") };
    const p = ports({ transports: () => down });
    const r = await answer(stateOf(await toTarget(p)), pick, p);
    expect([r.kind, r.kind === "failed" && r.error, stateOf(r).step]).toEqual(["failed", "SessionManagerPlugin is not found", "check"]);
  });
});

describe("aws guide: teardown", () => {
  const runner = () => ({
    name: "ec2",
    transport: { kind: "aws-ssm" as const, region: "eu-west-1", instanceId: "i-1", remotePort: 9000, credentials: { kind: "default" as const } },
    token: { kind: "vault" as const, key: "k" },
    origin: { guide: "aws", summary: "", teardown: { label: "", data: { instanceId: "i-1", region: "eu-west-1" } } },
  });

  test("uninstalls the runner and leaves the instance running", async () => {
    const scripts: string[] = [];
    await awsGuide.teardown!(runner(), ports({ aws: fakeAws(fakeHost({ sendScript: async (_id, s) => (scripts.push(s), ok("c")) })) }));
    expect(scripts[0]).toContain("systemctl disable --now fleet-runner");
  });
});
