import { useEffect, useRef } from "react";
import type { FleetModel } from "./fleet-types.js";
import { agentName, finishedSince, runTitle, taskTone } from "./fleet-view-model.js";

/** Desktop notifications for runs that finish while the Fleet page isn't in front of you. */
export function useFleetNotifications(model: FleetModel | null, { enabled, watching, onOpen }: { enabled: boolean; watching: boolean; onOpen: () => void }) {
  const prev = useRef<FleetModel | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    if (!model) return;
    const finished = finishedSince(prev.current, model);
    prev.current = model;
    const canNotify = typeof Notification !== "undefined" && Notification.permission === "granted";
    if (!enabled || !canNotify || (watching && !document.hidden)) return;
    finished.forEach((task) => {
      const failed = taskTone(task.state) === "bad";
      const notification = new Notification(`${agentName(model, task)} ${failed ? "failed" : "finished"}`, {
        body: failed && task.statusText ? task.statusText : runTitle(model, task),
        tag: `fleet:${task.id}`,
      });
      notification.onclick = () => {
        window.focus();
        open.current();
        notification.close();
      };
    });
  }, [model, enabled, watching]);
}
