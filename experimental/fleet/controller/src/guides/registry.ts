import { awsGuide } from "./aws/guide.js";
import type { RunnerGuide } from "./guide.js";
import { manualGuide } from "./manual.js";

/** The ways to add a runner, in the order "Add runner" lists them. Add a guide here to offer it. */
export const GUIDES: readonly RunnerGuide[] = [awsGuide, manualGuide];

export const guideById = (id: string, guides: readonly RunnerGuide[] = GUIDES): RunnerGuide | undefined => guides.find((g) => g.id === id);

export const catalog = (guides: readonly RunnerGuide[] = GUIDES) =>
  guides.map(({ id, title, description, comingSoon }) => ({ id, title, description, ...(comingSoon ? { comingSoon } : {}) }));
