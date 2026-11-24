import { useEffect, useMemo, useState } from "react";
import type { FleetModel } from "./fleet-types.js";

const CLOCK_MS = 1_000;

/**
 * The Controller doesn't send a frame when only its clock moves, so "seen 5s ago" and retry
 * countdowns run on this clock. It listens on 127.0.0.1 only, so both clocks are the same machine's.
 */
export function useFleetClock(model: FleetModel | null): FleetModel | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => (model ? { ...model, now: Math.max(now, model.now) } : null), [model, now]);
}
