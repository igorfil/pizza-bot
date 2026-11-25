// The contract for runner-guide plugins: built-in ones and the ones copied into runner-guides/.
// Plugin modules import only types from here, so they load without this package on their path.
import type { Transport } from "../transport.js";
import type { PluginTransport, TransportSpec } from "../types.js";
import type { SecretStore } from "../vault.js";
import type { RunnerGuide } from "./guide.js";

export type { Outcome } from "../outcome.js";
export type { OpenLink, Transport } from "../transport.js";
export type { ChecklistItem, GuideInput, GuideResult, GuideState, NewRunner, PluginTransport, RunnerOrigin, SecretRef, StepField, StepView, TransportSpec } from "../types.js";
export type { SecretStore } from "../vault.js";
export type { GuidePorts, RunnerGuide } from "./guide.js";

/** What the Controller hands a plugin when it loads it. */
export type PluginHost = {
  vault: SecretStore;
  /** Every transport the Controller knows, so a plugin's own transport can wrap a built-in one. */
  transports: (spec: TransportSpec) => Transport;
  /** The Linux runner build `npm run build` made (runner/target-linux/dist). */
  localBuildDir: string;
  /** Why a runner name can't be used, or null. */
  nameProblem: (name: string, taken: readonly string[]) => string | null;
};

export type GuidePlugin = {
  /** Unique; a `PluginTransport` names its plugin by this id. */
  id: string;
  guides: readonly RunnerGuide[];
  /** Opens the transports this plugin's guides save, the `{kind: "plugin"}` ones naming this plugin. */
  transport?: (spec: PluginTransport) => Transport;
};

/** A plugin module's default export. */
export type GuidePluginFactory = (host: PluginHost) => GuidePlugin | Promise<GuidePlugin>;
