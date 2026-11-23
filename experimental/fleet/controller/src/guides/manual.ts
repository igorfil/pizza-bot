import type { RunnerGuide } from "./guide.js";

/** Listed so Add runner shows it; the workflow isn't built yet. Scripts still add runners by URL with AddRunner. */
export const manualGuide: RunnerGuide = {
  id: "manual",
  title: "By URL",
  description: "A runner you started yourself, reached at its URL.",
  comingSoon: true,
  start: () => ({}),
  step: async (state) => ({ kind: "failed", state, view: { title: "By URL", fields: [] }, error: "Adding a runner by URL isn't available yet." }),
};
