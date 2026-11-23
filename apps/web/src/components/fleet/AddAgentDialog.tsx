import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { FleetModel, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { ChoiceCard, FleetDialog } from "./GuideCard.js";

const message = (e: unknown) => (e instanceof Error ? e.message : "The Controller didn't take that.");

type Mode = "create" | "existing";

/** What the runner can do for Add agent right now: a reason it can't, or the modes it offers. */
export const addAgentModes = (runner: FleetRunner): { blocker: string } | { modes: Mode[] } => {
  if (runner.status !== "healthy") return { blocker: `${runner.name} isn't reachable right now. Try again once it's online.` };
  const modes: Mode[] = [...(runner.canCreateAgents ? ["create" as const] : []), ...((runner.available?.length ?? 0) > 0 ? ["existing" as const] : [])];
  if (modes.length > 0) return { modes };
  return {
    blocker:
      runner.available == null
        ? `${runner.name} can't change its agents from here. Update the runner to a version that supports adding agents.`
        : `Every agent on ${runner.name} is already added.`,
  };
};

function Actions({ saving, disabled, label, onClose }: { saving: boolean; disabled: boolean; label: string; onClose: () => void }) {
  return (
    <div className="fleet-guide-actions">
      <span className="fleet-agent-links-spacer" />
      <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button type="submit" className="btn-primary fleet-small-btn" disabled={saving || disabled}>
        {saving && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
        {label}
      </button>
    </div>
  );
}

/** Sends one intent, closing the dialog on success and keeping the form with the reason on failure. */
const useSubmit = (onClose: () => void) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent, f: () => Promise<unknown>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await f();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, submit };
};

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <div className="schedule-editor-error" role="alert">
      {error}
    </div>
  ) : null;
}

/** The bare-minimum agent: a name, a model and a system prompt, run by the runner's built-in harness. */
function CreateAgentForm({ model, runner, send, onClose }: { model: FleetModel; runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const models = model.agentModels ?? [];
  const [name, setName] = useState("");
  const [picked, setPicked] = useState(models[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const { saving, error, submit } = useSubmit(onClose);
  return (
    <form
      className="fleet-guide"
      onSubmit={(e) => void submit(e, () => send("CreateAgent", { runner: runner.name, name: name.trim(), model: picked, systemPrompt }))}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Release notes writer" autoFocus />
      </label>
      <fieldset className="fleet-choice-field">
        <legend className="field-label fleet-choice-legend">Model</legend>
        <div className="fleet-choice-grid">
          {models.map((m) => (
            <ChoiceCard key={m.id} type="radio" name="model" value={m.id} checked={picked === m.id} title={m.label} detail={m.id} onChange={() => setPicked(m.id)} />
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">System prompt</span>
        <textarea
          className="field-input fleet-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder="You turn a list of merged pull requests into short, friendly release notes."
        />
        <span className="field-hint">Each run sends the message you type to the model with this prompt and returns its reply.</span>
      </label>
      <ErrorLine error={error} />
      <Actions saving={saving} disabled={name.trim() === "" || picked === ""} label="Create agent" onClose={onClose} />
    </form>
  );
}

/** Picks agents from what the runner has on disk but doesn't serve yet. */
function ExistingAgentsForm({ runner, send, onClose }: { runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const { saving, error, submit } = useSubmit(onClose);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <form className="fleet-guide" onSubmit={(e) => void submit(e, () => send("AddAgents", { runner: runner.name, agents: [...picked] }))}>
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
      <ErrorLine error={error} />
      <Actions saving={saving} disabled={picked.size === 0} label={picked.size > 1 ? `Add ${picked.size} agents` : "Add agent"} onClose={onClose} />
    </form>
  );
}

const MODE_LABELS: Record<Mode, string> = { create: "Create new", existing: "Turn on existing" };

export function AddAgentDialog({ model, runner, send, onClose }: { model: FleetModel; runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const offer = addAgentModes(runner);
  const [mode, setMode] = useState<Mode>("modes" in offer ? offer.modes[0]! : "create");
  return (
    <FleetDialog title={`Add agent to ${runner.name}`} onClose={onClose}>
      {"blocker" in offer ? (
        <>
          <p className="sidebar-modal-body">{offer.blocker}</p>
          <div className="fleet-guide-actions">
            <span className="fleet-agent-links-spacer" />
            <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          {offer.modes.length > 1 && (
            <div className="fleet-segmented" role="tablist" aria-label="How to add the agent">
              {offer.modes.map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "active" : undefined} onClick={() => setMode(m)}>
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}
          {mode === "create" ? (
            <CreateAgentForm model={model} runner={runner} send={send} onClose={onClose} />
          ) : (
            <ExistingAgentsForm runner={runner} send={send} onClose={onClose} />
          )}
        </>
      )}
    </FleetDialog>
  );
}
