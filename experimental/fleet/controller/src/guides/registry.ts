import { sdkAwsPort } from "./aws/ec2.js";
import { createAwsGuide, type AwsGuideDeps } from "./aws/guide.js";
import { pushLocalBuild } from "./aws/local-build.js";
import type { RunnerGuide } from "./guide.js";
import { manualGuide } from "./manual.js";
import type { GuidePlugin, PluginHost } from "./plugin.js";

/** The plugins that ship with the Controller; ones copied into the runner-guides folder are listed after them. */
export const builtInPlugins = (host: PluginHost, aws?: AwsGuideDeps): GuidePlugin[] => [
  { id: "aws", guides: [createAwsGuide(aws ?? { aws: sdkAwsPort(host.vault), pushLocalBuild: pushLocalBuild(host.vault) })] },
  { id: "manual", guides: [manualGuide] },
];

/** The ways to add a runner, in the order "Add runner" lists them. */
export const guidesOf = (plugins: readonly GuidePlugin[]): RunnerGuide[] => plugins.flatMap((p) => p.guides);

export const guideById = (id: string, guides: readonly RunnerGuide[]): RunnerGuide | undefined => guides.find((g) => g.id === id);

export const catalog = (guides: readonly RunnerGuide[]) =>
  guides.map(({ id, title, description, comingSoon }) => ({ id, title, description, ...(comingSoon ? { comingSoon } : {}) }));
