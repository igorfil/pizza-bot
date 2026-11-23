import * as a2a from "./a2a.js";
import type { GuidePorts, RunnerGuide } from "./guides/guide.js";
import type { PushLocalBuild } from "./guides/aws/local-build.js";
import type { AwsPort } from "./guides/aws/port.js";
import { catalog, guideById } from "./guides/registry.js";
import * as llm from "./llm.js";
import type { MsgLog } from "./log.js";
import { errorText, type Outcome } from "./outcome.js";
import { vaultKeys } from "./runners.js";
import type { Transport } from "./transport.js";
import type { Effect, Endpoint, LocalClock, Model, Msg, Sub, TransportSpec } from "./types.js";
import { initialModel, subscriptions, TICK_MS, update } from "./update.js";
import { reveal, type SecretStore } from "./vault.js";

export type Runtime = {
  send: (msgId: string, msg: Msg) => { version: number; duplicate: boolean };
  snapshot: () => { version: number; model: Model };
  onChange: (listener: (version: number, model: Model) => void) => () => void;
};

export type RuntimeDeps = {
  vault: SecretStore;
  transports: (spec: TransportSpec) => Transport;
  aws: AwsPort;
  guides: readonly RunnerGuide[];
  release: string;
  pushLocalBuild?: PushLocalBuild;
};

const localClock = (date: Date): LocalClock => ({
  day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  minute: date.getHours() * 60 + date.getMinutes(),
});

type Legacy = Record<string, unknown> & { type: string };

const withSsmKind = (transport: TransportSpec): TransportSpec =>
  (transport.kind as string) === "aws-ssm" ? ({ ...transport, kind: "aws_ssm" } as TransportSpec) : transport;

/** Msgs logged before transports, the vault and the `aws_ssm` kind replay as their current shape. */
export const upcast = (msg: Msg): Msg => {
  const m = msg as unknown as Legacy;
  if (m.type === "AddRunner" && typeof m.token === "string" && typeof m.url === "string") {
    return { type: "AddRunner", name: String(m.name), transport: { kind: "direct", url: m.url.replace(/\/+$/, "") }, token: { kind: "inline", value: m.token }, origin: null };
  }
  if (msg.type === "AddRunner") return { ...msg, transport: withSsmKind(msg.transport) };
  if (msg.type === "UpdateRunner" && msg.transport) return { ...msg, transport: withSsmKind(msg.transport) };
  if (msg.type === "GuideStepped" && msg.result.kind === "done") {
    return { ...msg, result: { ...msg.result, runner: { ...msg.result.runner, transport: withSsmKind(msg.result.runner.transport) } } };
  }
  if (m.type === "RemoveRunner" && typeof m.teardown !== "boolean") return { type: "RemoveRunner", name: String(m.name), teardown: false };
  if (m.type === "Booted" && !Array.isArray(m.guides)) return { type: "Booted", now: Number(m.now), guides: [] };
  return msg;
};

const replay = (log: MsgLog): { model: Model; version: number } =>
  log.all().reduce(
    (acc, entry) => ({ model: update(acc.model, upcast(entry.msg))[0], version: entry.seq }),
    { model: initialModel(), version: 0 },
  );

const indexFields = ({ agents, location, available, canCreate }: a2a.RunnerIndex) => ({ agents, location, available, canCreate });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const startRuntime = (log: MsgLog, deps: RuntimeDeps): Runtime => {
  let { model, version } = replay(log);
  const listeners = new Set<(version: number, model: Model) => void>();
  const streams = new Map<string, AbortController>();

  const world = (msg: Msg) => dispatch(crypto.randomUUID(), msg);

  const withToken = async (endpoint: Endpoint): Promise<Outcome<a2a.AgentEndpoint>> => {
    const token = await reveal(deps.vault, endpoint.token);
    return token.ok ? { ok: true, value: { url: endpoint.url, token: token.value } } : token;
  };

  const ports = (sessionId: string): GuidePorts => ({
    sessionId,
    runnerNames: Object.keys(model.runners),
    vault: deps.vault,
    aws: deps.aws,
    transports: deps.transports,
    fetch,
    sleep,
    release: deps.release,
    ...(deps.pushLocalBuild ? { pushLocalBuild: deps.pushLocalBuild } : {}),
  });

  const effectResult = async (effect: Effect): Promise<Msg | null> => {
    switch (effect.type) {
      case "CheckRunner": {
        const r = await a2a.checkRunner(effect.url);
        return r.ok
          ? { type: "RunnerOk", name: effect.runner, ...indexFields(r.value) }
          : { type: "RunnerFailed", name: effect.runner, error: r.error };
      }
      case "ChatComplete": {
        const r = await llm.complete(effect.system, effect.turns);
        return r.ok ? { type: "ChatReplied", chatId: effect.chatId, text: r.value } : { type: "ChatFailed", chatId: effect.chatId, error: r.error };
      }
      case "Dispatch": {
        const ep = await withToken(effect.endpoint);
        const r = ep.ok ? await a2a.dispatch(ep.value, effect.prompt) : ep;
        return r.ok ? { type: "Dispatched", taskId: effect.taskId, snapshot: r.value } : { type: "DispatchFailed", taskId: effect.taskId, error: r.error };
      }
      case "GetTask": {
        const ep = await withToken(effect.endpoint);
        const r = ep.ok ? await a2a.getTask(ep.value, effect.remoteId) : ep;
        return r.ok ? { type: "TaskSnapshot", taskId: effect.taskId, snapshot: r.value } : { type: "SyncFailed", taskId: effect.taskId, error: r.error };
      }
      case "Cancel": {
        const ep = await withToken(effect.endpoint);
        const r = ep.ok ? await a2a.cancel(ep.value, effect.remoteId) : ep;
        return r.ok ? { type: "TaskSnapshot", taskId: effect.taskId, snapshot: r.value } : { type: "CancelFailed", taskId: effect.taskId, error: r.error };
      }
      case "RunGuideStep": {
        const guide = guideById(effect.guide, deps.guides);
        if (!guide) return null;
        const state = effect.state ?? guide.start();
        try {
          return { type: "GuideStepped", sessionId: effect.sessionId, result: await guide.step(state, effect.input, ports(effect.sessionId)) };
        } catch (e) {
          return { type: "GuideStepped", sessionId: effect.sessionId, result: { kind: "failed", state, view: { title: guide.title, fields: [] }, error: errorText(e) } };
        }
      }
      case "DeleteSecrets":
        await Promise.all(effect.keys.map((k) => deps.vault.delete(k)));
        return null;
      case "SetRunnerAgents": {
        const ep = await withToken(effect.endpoint);
        const r = ep.ok ? await a2a.setAgents(ep.value.url, ep.value.token, effect.agents) : ep;
        return r.ok
          ? { type: "AgentsSet", runner: effect.runner, added: effect.added, ...indexFields(r.value) }
          : { type: "AgentsSetFailed", runner: effect.runner, error: r.error };
      }
      case "CreateRunnerAgent": {
        const ep = await withToken(effect.endpoint);
        const r = ep.ok ? await a2a.createAgent(ep.value.url, ep.value.token, effect.agent) : ep;
        return r.ok
          ? { type: "AgentsSet", runner: effect.runner, added: [r.value.created], ...indexFields(r.value) }
          : { type: "AgentsSetFailed", runner: effect.runner, error: r.error };
      }
      case "RetireRunner": {
        const { runner } = effect;
        const guide = runner.origin ? guideById(runner.origin.guide, deps.guides) : undefined;
        const torn = effect.teardown && guide?.teardown ? await guide.teardown(runner, ports(`retire:${runner.name}`)) : null;
        await Promise.all(vaultKeys(runner).map((k) => deps.vault.delete(k)));
        if (!torn) return { type: "RunnerRetired", name: runner.name, ok: true, text: `runner ${runner.name} removed` };
        return torn.ok
          ? { type: "RunnerRetired", name: runner.name, ok: true, text: `runner ${runner.name} removed: ${torn.value}` }
          : { type: "RunnerRetired", name: runner.name, ok: false, text: `runner ${runner.name} removed, but teardown failed: ${torn.error}` };
      }
    }
  };

  const openStream = (sub: Extract<Sub, { type: "TaskStream" }>, controller: AbortController) =>
    withToken(sub.endpoint).then((ep) =>
      ep.ok
        ? a2a.stream(ep.value, sub.remoteId, controller.signal, (event) =>
            world(
              event.kind === "snapshot"
                ? { type: "TaskSnapshot", taskId: sub.taskId, snapshot: event.snapshot }
                : { type: "TaskUpdated", taskId: sub.taskId, update: event.update },
            ),
          )
        : ep.error,
    );

  const openLink = async (sub: Extract<Sub, { type: "Link" }>, controller: AbortController): Promise<string | null> => {
    const link = await deps.transports(sub.transport).open(controller.signal);
    if (!link.ok) return link.error;
    if (!controller.signal.aborted) world({ type: "LinkUp", runner: sub.runner, epoch: sub.epoch, url: link.value.url });
    return link.value.closed;
  };

  const open = (sub: Sub) => {
    const controller = new AbortController();
    streams.set(sub.key, controller);
    const ended = sub.type === "Link" ? openLink(sub, controller) : openStream(sub, controller);
    void ended.then((error) => {
      if (streams.get(sub.key) !== controller) return;
      streams.delete(sub.key);
      world(
        sub.type === "Link"
          ? { type: "LinkDown", runner: sub.runner, epoch: sub.epoch, error }
          : { type: "StreamDropped", taskId: sub.taskId, epoch: sub.epoch, error },
      );
    });
  };

  const reconcile = () => {
    const wanted = new Map(subscriptions(model).map((s) => [s.key, s]));
    [...streams.entries()]
      .filter(([key]) => !wanted.has(key))
      .forEach(([key, controller]) => {
        streams.delete(key);
        controller.abort();
      });
    [...wanted.values()].filter((s) => !streams.has(s.key)).forEach(open);
  };

  const runEffect = (effect: Effect) =>
    effectResult(effect).then((msg) => {
      if (msg) world(msg);
    });

  const dispatch = (msgId: string, msg: Msg): { version: number; duplicate: boolean } => {
    if (log.has(msgId)) return { version, duplicate: true };
    version = log.append(msgId, msg);
    const [next, effects] = update(model, msg);
    model = next;
    effects.forEach(runEffect);
    reconcile();
    listeners.forEach((l) => l(version, model));
    return { version, duplicate: false };
  };

  world({ type: "Booted", now: Date.now(), guides: catalog(deps.guides) });
  setInterval(() => {
    const now = Date.now();
    world({ type: "Tick", now, local: localClock(new Date(now)) });
  }, TICK_MS);

  return {
    send: dispatch,
    snapshot: () => ({ version, model }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
