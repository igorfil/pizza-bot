import type { Model, NewRunner, Notification, Runner, SecretRef } from "./types.js";

const MAX_NOTIFICATIONS = 20;

export const notify = (model: Model, level: Notification["level"], text: string): Model => ({
  ...model,
  notifications: [...model.notifications, { at: model.now, level, text }].slice(-MAX_NOTIFICATIONS),
});

export const setRunner = (model: Model, runner: Runner): Model => ({
  ...model,
  runners: { ...model.runners, [runner.name]: runner },
});

/** A new runner starts with its link down; the Link subscription opens it. */
export const addRunner = (model: Model, spec: NewRunner): Model =>
  notify(
    setRunner(model, {
      ...spec,
      link: { state: "down", error: null },
      linkEpoch: 0,
      linkFailures: 0,
      linkRetryAt: 0,
      status: "unknown",
      failures: 0,
      nextCheckAt: model.now,
      lastSeenAt: null,
      lastError: null,
      location: null,
      canCreateAgents: false,
      harnesses: [],
      plugins: [],
      mcpServers: {},
      agentsChange: null,
    }),
    "info",
    `runner ${spec.name} added`,
  );

const vaultKey = (ref: SecretRef): string[] => (ref.kind === "vault" ? [ref.key] : []);

/** Every vault entry a runner's config points at, so removing the runner can delete them. */
export const vaultKeys = (runner: NewRunner): string[] => [
  ...vaultKey(runner.token),
  ...(runner.transport.kind === "aws_ssm" && runner.transport.credentials.kind === "keys"
    ? [...vaultKey(runner.transport.credentials.accessKeyId), ...vaultKey(runner.transport.credentials.secretAccessKey)]
    : []),
];

export const runnerSpec = (r: Runner): NewRunner => ({ name: r.name, transport: r.transport, token: r.token, origin: r.origin });
