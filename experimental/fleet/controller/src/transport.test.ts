import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { awsEnv, direct, ssmArgs, transportFor } from "./transport.js";
import type { TransportSpec } from "./types.js";
import { memoryVault } from "./vault.js";

const dir = mkdtempSync(join(tmpdir(), "fleet-transport-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** Stands in for the AWS CLI: records its arguments and environment, then behaves as told. */
const fakeAws = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "$@" > "${path}.args"\nenv > "${path}.env"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const spec: Extract<TransportSpec, { kind: "aws-ssm" }> = {
  kind: "aws-ssm",
  region: "eu-west-1",
  instanceId: "i-1",
  remotePort: 9000,
  credentials: { kind: "profile", profile: "dev" },
};

describe.skipIf(process.platform === "win32")("aws-ssm transport", () => {
  test("is up once the session manager says it is waiting for connections", async () => {
    const aws = fakeAws("ready", 'echo "Starting session"; echo "Waiting for connections..."; sleep 30');
    const abort = new AbortController();
    const link = await transportFor(spec, { vault: memoryVault(), awsCommand: aws }).open(abort.signal);
    abort.abort();
    expect(link.ok && /^http:\/\/127\.0\.0\.1:\d+$/.test(link.value.url)).toBe(true);
  });

  test("closing the link after it was aborted reports no error", async () => {
    const aws = fakeAws("abort", 'echo "Waiting for connections..."; sleep 30');
    const abort = new AbortController();
    const link = await transportFor(spec, { vault: memoryVault(), awsCommand: aws }).open(abort.signal);
    abort.abort();
    expect(link.ok ? await link.value.closed : "not open").toBeNull();
  });

  test("a session that ends reports its last error line as the reason", async () => {
    const aws = fakeAws("drop", 'echo "Waiting for connections..."; sleep 0.2; echo "An error occurred (TargetNotConnected)" >&2; exit 255');
    const link = await transportFor(spec, { vault: memoryVault(), awsCommand: aws }).open(new AbortController().signal);
    expect(link.ok ? await link.value.closed : "not open").toBe("An error occurred (TargetNotConnected)");
  });

  test("a session that never starts fails with its error", async () => {
    const aws = fakeAws("fail", 'echo "SessionManagerPlugin is not found" >&2; exit 255');
    const link = await transportFor(spec, { vault: memoryVault(), awsCommand: aws }).open(new AbortController().signal);
    expect(link).toEqual({ ok: false, error: "SessionManagerPlugin is not found" });
  });

  test("gives up when the session is not ready in time", async () => {
    const aws = fakeAws("slow", "sleep 30");
    const link = await transportFor(spec, { vault: memoryVault(), awsCommand: aws, readyTimeoutMs: 200 }).open(new AbortController().signal);
    expect(link).toEqual({ ok: false, error: "tunnel not ready after 0.2s" });
  });

  test("forwards the runner port with the profile's credentials", async () => {
    const aws = fakeAws("args", 'echo "Waiting for connections..."; sleep 30');
    const abort = new AbortController();
    await transportFor(spec, { vault: memoryVault(), awsCommand: aws }).open(abort.signal);
    abort.abort();
    const { readFileSync } = await import("node:fs");
    const args = readFileSync(`${aws}.args`, "utf8");
    const env = readFileSync(`${aws}.env`, "utf8");
    expect([args.includes("AWS-StartPortForwardingSession"), args.includes("portNumber=9000,localPortNumber="), env.includes("AWS_PROFILE=dev")]).toEqual([true, true, true]);
  });
});

describe("transports", () => {
  test("direct is up at its URL right away", async () => {
    const link = await direct("http://h:9301/").open(new AbortController().signal);
    expect(link.ok && link.value.url).toBe("http://h:9301");
  });

  test("ssm arguments name the instance, region and both ports", () => {
    expect(ssmArgs(spec, 5555)).toEqual([
      "ssm",
      "start-session",
      "--region",
      "eu-west-1",
      "--target",
      "i-1",
      "--document-name",
      "AWS-StartPortForwardingSession",
      "--parameters",
      "portNumber=9000,localPortNumber=5555",
    ]);
  });

  test("access keys are read from the vault into the environment", async () => {
    const vault = memoryVault({ a: "AKIA", b: "secret" });
    const env = await awsEnv(vault, { kind: "keys", accessKeyId: { kind: "vault", key: "a" }, secretAccessKey: { kind: "vault", key: "b" } });
    expect(env).toEqual({ ok: true, value: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret" } });
  });

  test("a key missing from the vault is an error, not an empty credential", async () => {
    const env = await awsEnv(memoryVault(), { kind: "keys", accessKeyId: { kind: "vault", key: "a" }, secretAccessKey: { kind: "vault", key: "b" } });
    expect(env).toEqual({ ok: false, error: "secret a is missing from the vault" });
  });
});
