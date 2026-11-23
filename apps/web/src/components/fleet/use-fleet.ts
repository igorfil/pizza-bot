import { useCallback, useEffect, useState } from "react";
import {
  loadFleetConnection,
  saveFleetConnection,
  sendFleetIntent,
  streamFleetModel,
  FleetError,
  type FleetConnection,
  type FleetIntent,
  type FleetPayload,
} from "./fleet-client.js";
import type { FleetModel } from "./fleet-types.js";

export type FleetLink =
  | { kind: "unconfigured" }
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "retrying"; error: string }
  | { kind: "rejected"; error: string };

const RETRY_MS = 2_000;

const describe = (e: unknown): string => {
  if (e instanceof FleetError && e.status === 401) return "The Controller rejected the token.";
  if (e instanceof FleetError && e.status === 403)
    return "The Controller doesn't allow this app's origin. Add it to FLEET_ALLOWED_ORIGINS.";
  if (e instanceof FleetError) return e.message;
  return "Can't reach the Controller. Is it running?";
};

/** Auth and origin failures won't fix themselves, so they stop the retry loop. */
const isFatal = (e: unknown) => e instanceof FleetError && (e.status === 401 || e.status === 403);

export function useFleet() {
  const [connection, setConnection] = useState<FleetConnection | null>(loadFleetConnection);
  const [model, setModel] = useState<FleetModel | null>(null);
  const [link, setLink] = useState<FleetLink>({ kind: "connecting" });

  useEffect(() => {
    if (!connection) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const follow = async () => {
      try {
        await streamFleetModel(connection, abort.signal, (next) => {
          setModel(next);
          setLink({ kind: "live" });
        });
        if (!abort.signal.aborted) setLink({ kind: "retrying", error: "The Controller closed the stream." });
      } catch (e) {
        if (abort.signal.aborted) return;
        if (isFatal(e)) return setLink({ kind: "rejected", error: describe(e) });
        setLink({ kind: "retrying", error: describe(e) });
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void follow(), RETRY_MS);
    };

    setLink({ kind: "connecting" });
    void follow();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [connection]);

  const connect = useCallback((next: FleetConnection | null) => {
    saveFleetConnection(next);
    setModel(null);
    setLink(next ? { kind: "connecting" } : { kind: "unconfigured" });
    setConnection(next);
  }, []);

  const send = useCallback(
    async (type: FleetIntent, payload: FleetPayload): Promise<string | null> => {
      if (!connection) throw new FleetError("Not connected to a Controller.");
      try {
        return await sendFleetIntent(connection, type, payload);
      } catch (e) {
        throw new FleetError(describe(e));
      }
    },
    [connection],
  );

  return { connection, model, link, connect, send };
}
