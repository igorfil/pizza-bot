import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { ChoiceCard, FleetDialog } from "./GuideCard.js";

const message = (e: unknown) => (e instanceof Error ? e.message : "The Controller didn't take that.");

/** Why the runner can't take new agents right now, or null when it can. */
export const addAgentBlocker = (runner: FleetRunner): string | null => {
  if (runner.status !== "healthy") return `${runner.name} isn't reachable right now. Try again once it's online.`;
  if (runner.available == null) return `${runner.name} can't change its agents from here. Update the runner to a version that supports adding agents.`;
  if (runner.available.length === 0) return `Every agent on ${runner.name} is already added.`;
  return null;
};

/** Picks agents from what the runner has on disk but doesn't serve yet. */
export function AddAgentDialog({ runner, send, onClose }: { runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = addAgentBlocker(runner);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await send("AddAgents", { runner: runner.name, agents: [...picked] });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FleetDialog title={`Add agent to ${runner.name}`} onClose={onClose}>
      {blocker ? (
        <>
          <p className="sidebar-modal-body">{blocker}</p>
          <div className="fleet-guide-actions">
            <span className="fleet-agent-links-spacer" />
            <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form className="fleet-guide" onSubmit={(e) => void submit(e)}>
          <p className="field-hint">Pick what {runner.name} should also run. They're already on the machine, so nothing is installed.</p>
          <fieldset className="fleet-choice-field">
            <legend className="field-label fleet-choice-legend">Agents</legend>
            <div className="fleet-choice-grid">
              {(runner.available ?? []).map((a) => (
                <ChoiceCard
                  key={a.id}
                  type="checkbox"
                  name="agents"
                  value={a.id}
                  checked={picked.has(a.id)}
                  title={a.name}
                  {...(a.description ? { detail: a.description } : {})}
                  onChange={() => toggle(a.id)}
                />
              ))}
            </div>
          </fieldset>
          {error && (
            <div className="schedule-editor-error" role="alert">
              {error}
            </div>
          )}
          <div className="fleet-guide-actions">
            <span className="fleet-agent-links-spacer" />
            <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary fleet-small-btn" disabled={saving || picked.size === 0}>
              {saving && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
              {picked.size > 1 ? `Add ${picked.size} agents` : "Add agent"}
            </button>
          </div>
        </form>
      )}
    </FleetDialog>
  );
}
