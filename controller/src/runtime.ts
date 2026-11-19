import * as a2a from "./a2a.ts";
import type { MsgLog } from "./log.ts";
import type { Effect, Model, Msg, Sub } from "./types.ts";
import { initialModel, subscriptions, TICK_MS, update } from "./update.ts";

export type Runtime = {
  send: (msgId: string, msg: Msg) => { version: number; duplicate: boolean };
  snapshot: () => { version: number; model: Model };
  onChange: (listener: (version: number, model: Model) => void) => () => void;
};

const replay = (log: MsgLog): { model: Model; version: number } =>
  log.all().reduce(
    (acc, entry) => ({ model: update(acc.model, entry.msg)[0], version: entry.seq }),
    { model: initialModel(), version: 0 },
  );

const effectResult = async (effect: Effect): Promise<Msg | null> => {
  switch (effect.type) {
    case "CheckRunner": {
      const r = await a2a.checkRunner(effect.runner);
      return r.ok
        ? { type: "RunnerOk", name: effect.runner.name, agent: r.value }
        : { type: "RunnerFailed", name: effect.runner.name, error: r.error };
    }
    case "Dispatch": {
      const r = await a2a.dispatch(effect.runner, effect.prompt);
      return r.ok
        ? { type: "Dispatched", taskId: effect.taskId, snapshot: r.value }
        : { type: "DispatchFailed", taskId: effect.taskId, error: r.error };
    }
    case "GetTask": {
      const r = await a2a.getTask(effect.runner, effect.remoteId);
      return r.ok
        ? { type: "TaskSnapshot", taskId: effect.taskId, snapshot: r.value }
        : { type: "SyncFailed", taskId: effect.taskId, error: r.error };
    }
    case "Cancel": {
      const r = await a2a.cancel(effect.runner, effect.remoteId);
      return r.ok
        ? { type: "TaskSnapshot", taskId: effect.taskId, snapshot: r.value }
        : { type: "CancelFailed", taskId: effect.taskId, error: r.error };
    }
  }
};

export const startRuntime = (log: MsgLog): Runtime => {
  let { model, version } = replay(log);
  const listeners = new Set<(version: number, model: Model) => void>();
  const streams = new Map<string, AbortController>();

  const world = (msg: Msg) => dispatch(crypto.randomUUID(), msg);

  const openStream = (sub: Sub) => {
    const controller = new AbortController();
    streams.set(sub.key, controller);
    a2a
      .stream(sub.runner, sub.remoteId, controller.signal, (event) =>
        world(
          event.kind === "snapshot"
            ? { type: "TaskSnapshot", taskId: sub.taskId, snapshot: event.snapshot }
            : { type: "TaskUpdated", taskId: sub.taskId, update: event.update },
        ),
      )
      .then((error) => {
        if (streams.get(sub.key) !== controller) return;
        streams.delete(sub.key);
        world({ type: "StreamDropped", taskId: sub.taskId, epoch: sub.epoch, error });
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
    [...wanted.values()].filter((s) => !streams.has(s.key)).forEach(openStream);
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

  world({ type: "Booted", now: Date.now() });
  setInterval(() => world({ type: "Tick", now: Date.now() }), TICK_MS);

  return {
    send: dispatch,
    snapshot: () => ({ version, model }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
