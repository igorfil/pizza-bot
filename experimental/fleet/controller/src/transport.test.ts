import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { awsEnv, direct, sshArgs, ssmArgs, transportFor } from "./transport.js";
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

const spec: Extract<TransportSpec, { kind: "aws_ssm" }> = {
  kind: "aws_ssm",
  region: "eu-west-1",
  instanceId: "i-1",
  remotePort: 9000,
  credentials: { kind: "profile", profile: "dev" },
};

describe.skipIf(process.platform === "win32")("aws_ssm transport", () => {
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

/** Stands in for ssh: listens on the -L local port like a live forward, after `delayMs`; with `dropWith`, exits 500ms later saying so. */
const fakeSsh = (name: string, delayMs = 0, dropWith?: string): string => {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const forward = process.argv[process.argv.indexOf("-L") + 1];
const port = Number(forward.split(":")[1]);
setTimeout(() => require("node:net").createServer((s) => s.destroy()).listen(port, "127.0.0.1"), ${delayMs});
${dropWith ? `setTimeout(() => { process.stderr.write(${JSON.stringify(dropWith + "\n")}); process.exit(255); }, ${delayMs + 500});` : ""}
`,
  );
  chmodSync(path, 0o755);
  return path;
};

const sshSpec: Extract<TransportSpec, { kind: "ssh" }> = { kind: "ssh", host: "box", user: "ec2-user", port: 2222, identityFile: "~/.ssh/k", remotePort: 9000 };

describe.skipIf(process.platform === "win32")("ssh transport", () => {
  test("is up once the forwarded local port accepts connections", async () => {
    const abort = new AbortController();
    const link = await transportFor(sshSpec, { vault: memoryVault(), sshCommand: fakeSsh("ssh-ready", 300) }).open(abort.signal);
    abort.abort();
    expect(link.ok && /^http:\/\/127\.0\.0\.1:\d+$/.test(link.value.url)).toBe(true);
  });

  test("closing the link after it was aborted reports no error", async () => {
    const abort = new AbortController();
    const link = await transportFor(sshSpec, { vault: memoryVault(), sshCommand: fakeSsh("ssh-abort") }).open(abort.signal);
    abort.abort();
    expect(link.ok ? await link.value.closed : "not open").toBeNull();
  });

  test("an ssh that exits before the forward is up fails with its last error line", async () => {
    const ssh = fakeAws("ssh-denied", 'echo "ec2-user@box: Permission denied (publickey)." >&2; exit 255');
    const link = await transportFor(sshSpec, { vault: memoryVault(), sshCommand: ssh }).open(new AbortController().signal);
    expect(link).toEqual({ ok: false, error: "ec2-user@box: Permission denied (publickey)." });
  });

  test("a dropped session reports its last error line as the reason", async () => {
    const link = await transportFor(sshSpec, { vault: memoryVault(), sshCommand: fakeSsh("ssh-drop", 0, "Connection to box closed by remote host.") }).open(
      new AbortController().signal,
    );
    expect(link.ok ? await link.value.closed : "not open").toBe("Connection to box closed by remote host.");
  });

  test("gives up when the forward is not ready in time", async () => {
    const link = await transportFor(sshSpec, { vault: memoryVault(), sshCommand: fakeAws("ssh-slow", "sleep 30"), readyTimeoutMs: 300 }).open(new AbortController().signal);
    expect(link).toEqual({ ok: false, error: "tunnel not ready after 0.3s" });
  });
});

describe("transports", () => {
  test("ssh arguments forward a loopback port and never prompt", () => {
    expect(sshArgs(sshSpec, 5555)).toEqual([
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      "127.0.0.1:5555:127.0.0.1:9000",
      "-p",
      "2222",
      "-i",
      "~/.ssh/k",
      "-o",
      "IdentitiesOnly=yes",
      "-l",
      "ec2-user",
      "--",
      "box",
    ]);
  });

  test("ssh leaves unset user, port and key to ~/.ssh/config", () => {
    expect(sshArgs({ ...sshSpec, user: null, port: null, identityFile: null }, 5555).slice(-3)).toEqual(["127.0.0.1:5555:127.0.0.1:9000", "--", "box"]);
  });

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
