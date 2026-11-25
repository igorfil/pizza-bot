import type { Outcome } from "../outcome.js";
import type { Transport } from "../transport.js";
import type { GuideInput, GuideResult, GuideState, NewRunner, TransportSpec } from "../types.js";
import type { SecretStore } from "../vault.js";

/** Everything a guide step may touch. Tests pass fakes; the runtime passes the real thing. */
export type GuidePorts = {
  sessionId: string;
  runnerNames: readonly string[];
  vault: SecretStore;
  transports: (spec: TransportSpec) => Transport;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

/**
 * One way to add a runner. `step` turns the logged state plus the user's answer into the next
 * screen; it must be safe to call again with the same state, since the Controller can die mid-step.
 */
export interface RunnerGuide {
  id: string;
  title: string;
  description: string;
  /** Shown in Add runner but not startable yet. */
  comingSoon?: boolean;
  start(): GuideState;
  step(state: GuideState, input: GuideInput | null, ports: GuidePorts): Promise<GuideResult>;
  teardown?(runner: NewRunner, ports: GuidePorts): Promise<Outcome<string>>;
}

export const RUNNER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const nameProblem = (name: string, taken: readonly string[]): string | null =>
  !RUNNER_NAME.test(name)
    ? "Use lowercase letters, digits and dashes, starting with a letter."
    : taken.includes(name)
      ? `A runner named ${name} already exists.`
      : null;
