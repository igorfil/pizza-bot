import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { fail, ok, type Outcome } from "./outcome.js";
import type { AwsCredentials, SshTransport, TransportSpec } from "./types.js";
import { reveal, type SecretStore } from "./vault.js";

export type OpenLink = { url: string; closed: Promise<string | null> };

/** A live way to reach one runner. `closed` resolves (with the reason, or null) when the link drops. */
export interface Transport {
  open(signal: AbortSignal): Promise<Outcome<OpenLink>>;
}

export type TransportDeps = {
  vault: SecretStore;
  /** The AWS CLI; it starts session-manager-plugin for the port forward. */
  awsCommand?: string;
  sshCommand?: string;
  readyTimeoutMs?: number;
};

const whenAborted = (signal: AbortSignal): Promise<null> =>
  new Promise((resolve) => (signal.aborted ? resolve(null) : signal.addEventListener("abort", () => resolve(null), { once: true })));

export const direct = (url: string): Transport => ({
  open: (signal) => Promise.resolve(ok({ url: url.replace(/\/+$/, ""), closed: whenAborted(signal) })),
});

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

export const awsEnv = async (vault: SecretStore, creds: AwsCredentials): Promise<Outcome<Record<string, string>>> => {
  switch (creds.kind) {
    case "default":
      return ok({});
    case "profile":
      return ok({ AWS_PROFILE: creds.profile });
    case "keys": {
      const id = await reveal(vault, creds.accessKeyId);
      if (!id.ok) return id;
      const secret = await reveal(vault, creds.secretAccessKey);
      if (!secret.ok) return secret;
      return ok({ AWS_ACCESS_KEY_ID: id.value, AWS_SECRET_ACCESS_KEY: secret.value });
    }
  }
};

export const ssmArgs = (spec: Extract<TransportSpec, { kind: "aws_ssm" }>, localPort: number): string[] => [
  "ssm",
  "start-session",
  "--region",
  spec.region,
  "--target",
  spec.instanceId,
  "--document-name",
  "AWS-StartPortForwardingSession",
  "--parameters",
  `portNumber=${spec.remotePort},localPortNumber=${localPort}`,
];

const READY = "Waiting for connections";

/** SSM port forwarding: no inbound ports and no SSH key on the instance. */
export const awsSsm = (spec: Extract<TransportSpec, { kind: "aws_ssm" }>, deps: TransportDeps): Transport => ({
  open: async (signal) => {
    const env = await awsEnv(deps.vault, spec.credentials);
    if (!env.ok) return env;
    const port = await freePort();
    const child = spawn(deps.awsCommand ?? "aws", ssmArgs(spec, port), {
      env: { ...process.env, ...env.value, AWS_PAGER: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let lastLine = "";
    const remember = (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").map((l) => l.trim()).filter(Boolean);
      lastLine = lines.at(-1) ?? lastLine;
    };
    child.stderr.on("data", remember);
    const exited = new Promise<string>((resolve) => {
      child.once("error", (e) => resolve(e.message));
      child.once("exit", (code) => resolve(lastLine || `tunnel exited (${code ?? "signal"})`));
    });
    const kill = () => child.kill("SIGTERM");
    signal.addEventListener("abort", kill, { once: true });

    const ready = await new Promise<Outcome<void>>((resolve) => {
      const timer = setTimeout(() => resolve(fail(`tunnel not ready after ${(deps.readyTimeoutMs ?? 30_000) / 1000}s`)), deps.readyTimeoutMs ?? 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        remember(chunk);
        if (chunk.toString().includes(READY)) {
          clearTimeout(timer);
          resolve(ok(undefined));
        }
      });
      void exited.then((reason) => {
        clearTimeout(timer);
        resolve(fail(reason));
      });
    });
    if (!ready.ok) {
      kill();
      return ready;
    }
    return ok({ url: `http://127.0.0.1:${port}`, closed: exited.then((reason) => (signal.aborted ? null : reason)) });
  },
});

export const sshArgs = (spec: SshTransport, localPort: number): string[] => [
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
  `127.0.0.1:${localPort}:127.0.0.1:${spec.remotePort}`,
  ...(spec.port ? ["-p", String(spec.port)] : []),
  ...(spec.identityFile ? ["-i", spec.identityFile, "-o", "IdentitiesOnly=yes"] : []),
  ...(spec.user ? ["-l", spec.user] : []),
  "--",
  spec.host,
];

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => (socket.destroy(), resolve(false)));
  });

const PROBE_MS = 200;

/** `ssh -N` prints nothing once up; the forward is ready when its local port accepts connections. */
export const ssh = (spec: SshTransport, deps: TransportDeps): Transport => ({
  open: async (signal) => {
    const port = await freePort();
    const child = spawn(deps.sshCommand ?? "ssh", sshArgs(spec, port), { stdio: ["ignore", "ignore", "pipe"] });
    let lastLine = "";
    child.stderr.on("data", (chunk: Buffer) => {
      lastLine = chunk.toString().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? lastLine;
    });
    let exitReason: string | null = null;
    const exited = new Promise<string>((resolve) => {
      child.once("error", (e) => resolve(e.message));
      child.once("exit", (code) => resolve(lastLine || `ssh exited (${code ?? "signal"})`));
    });
    void exited.then((reason) => {
      exitReason = reason;
    });
    const kill = () => child.kill("SIGTERM");
    signal.addEventListener("abort", kill, { once: true });

    const timeoutMs = deps.readyTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const waitReady = async (): Promise<Outcome<void>> => {
      if (exitReason !== null) return fail(exitReason);
      if (signal.aborted) return fail("aborted");
      if (await accepts(port)) return ok(undefined);
      if (Date.now() >= deadline) return fail(`tunnel not ready after ${timeoutMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
      return waitReady();
    };
    const ready = await waitReady();
    if (!ready.ok) {
      kill();
      return ready;
    }
    return ok({ url: `http://127.0.0.1:${port}`, closed: exited.then((reason) => (signal.aborted ? null : reason)) });
  },
});

export const transportFor = (spec: TransportSpec, deps: TransportDeps): Transport => {
  switch (spec.kind) {
    case "direct":
      return direct(spec.url);
    case "aws_ssm":
      return awsSsm(spec, deps);
    case "ssh":
      return ssh(spec, deps);
  }
};
