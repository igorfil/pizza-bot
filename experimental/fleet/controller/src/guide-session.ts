import { addRunner, notify, vaultKeys } from "./runners.js";
import type { Effect, GuideInput, GuideResult, GuideSession, Model } from "./types.js";

type Result = [Model, Effect[]];

const RESTARTED = "The Controller restarted during this step. Retry to continue.";

const setSession = (model: Model, session: GuideSession): Model => ({
  ...model,
  guideSessions: { ...model.guideSessions, [session.id]: { ...session, updatedAt: model.now } },
});

const dropSession = (model: Model, id: string): Model => {
  const { [id]: _gone, ...rest } = model.guideSessions;
  return { ...model, guideSessions: rest };
};

const step = (session: GuideSession, input: GuideInput | null): Effect => ({
  type: "RunGuideStep",
  sessionId: session.id,
  attempt: session.attempt,
  guide: session.guide,
  state: session.state,
  input,
});

const deleteSecrets = (keys: string[]): Effect[] => (keys.length > 0 ? [{ type: "DeleteSecrets", keys }] : []);

const withSession = (model: Model, id: string, f: (s: GuideSession) => Result): Result => {
  const session = model.guideSessions[id];
  return session ? f(session) : [model, []];
};

export const startGuide = (model: Model, sessionId: string, guide: string): Result => {
  const info = model.guideCatalog.find((g) => g.id === guide);
  if (!info) return [notify(model, "error", `unknown guide ${guide}`), []];
  if (info.comingSoon) return [notify(model, "error", `${info.title} isn't available yet`), []];
  if (model.guideSessions[sessionId]) return [model, []];
  const session: GuideSession = {
    id: sessionId,
    guide,
    status: "working",
    state: null,
    view: { title: info.title, progress: "Starting…", fields: [] },
    error: null,
    secretKeys: [],
    attempt: 0,
    createdAt: model.now,
    updatedAt: model.now,
  };
  return [setSession(model, session), [step(session, null)]];
};

export const guideInput = (model: Model, sessionId: string, input: GuideInput): Result =>
  withSession(model, sessionId, (s) => {
    if (s.status !== "ask") return [model, []];
    const secrets = s.view.fields
      .filter((f) => f.kind === "secret")
      .map((f) => input[f.id])
      .filter((key): key is string => typeof key === "string" && key.length > 0);
    const next: GuideSession = { ...s, status: "working", error: null, secretKeys: [...s.secretKeys, ...secrets] };
    return [setSession(model, next), [step(next, input)]];
  });

/** Repeats the current step after a failure, or while it still runs but seems stuck; steps are safe to repeat. */
export const guideRetry = (model: Model, sessionId: string): Result =>
  withSession(model, sessionId, (s) => {
    if (s.status === "ask") return [model, []];
    const next: GuideSession = { ...s, status: "working", error: null, attempt: s.attempt + 1 };
    return [setSession(model, next), [step(next, null)]];
  });

export const cancelGuide = (model: Model, sessionId: string): Result =>
  withSession(model, sessionId, (s) => [dropSession(model, s.id), deleteSecrets(s.secretKeys)]);

export const guideStepped = (model: Model, sessionId: string, attempt: number, result: GuideResult): Result =>
  withSession(model, sessionId, (s) => {
    if (attempt !== s.attempt) return [model, []];
    switch (result.kind) {
      case "ask":
        return [setSession(model, { ...s, status: "ask", state: result.state, view: result.view, error: result.error ?? null }), []];
      case "working": {
        const next: GuideSession = { ...s, status: "working", state: result.state, view: result.view, error: null };
        return [setSession(model, next), [step(next, null)]];
      }
      case "failed":
        return [setSession(model, { ...s, status: "failed", state: result.state, view: result.view, error: result.error }), []];
      case "done": {
        if (model.runners[result.runner.name]) {
          return [setSession(model, { ...s, status: "failed", error: `A runner named ${result.runner.name} already exists.` }), []];
        }
        const kept = new Set(vaultKeys(result.runner));
        return [addRunner(dropSession(model, s.id), result.runner), deleteSecrets(s.secretKeys.filter((k) => !kept.has(k)))];
      }
    }
  });

/** A step that was running when the Controller died never reported back. */
export const interruptGuides = (model: Model): Model =>
  Object.values(model.guideSessions)
    .filter((s) => s.status === "working")
    .reduce((m, s) => setSession(m, { ...s, status: "failed", error: RESTARTED }), model);
