import { useState, type FormEvent } from "react";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { FleetGuideSession, FleetModel, FleetRunner, FleetStepView } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { initialDraft } from "./fleet-view-model.js";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** "Add runner": the guides the Controller offers. Picking one starts a session in the Controller. */
export function GuidePicker({ model, send, onClose }: { model: FleetModel; send: FleetSend; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const guides = model.guideCatalog ?? [];

  const start = async (guide: string) => {
    setStarting(guide);
    setError(null);
    try {
      await send("StartGuide", { guide });
      onClose();
    } catch (e) {
      setError(message(e, "Couldn't start the guide."));
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className="fleet-agent-card fleet-agent-form" role="group" aria-label="Add runner">
      <h3 className="fleet-agent-name">Add runner</h3>
      <p className="field-hint">Where should the runner live?</p>
      {guides.length === 0 && <p className="fleet-muted">This Controller offers no guides.</p>}
      <div className="fleet-guide-options">
        {guides.map((g) => (
          <button key={g.id} type="button" className="fleet-guide-pick" disabled={starting !== null} onClick={() => void start(g.id)}>
            <span className="fleet-guide-pick-title">{g.title}</span>
            <span className="fleet-muted">{g.description}</span>
          </button>
        ))}
      </div>
      {error && <div className="schedule-editor-error" role="alert">{error}</div>}
      <div className="fleet-agent-run-actions">
        <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function StepFields({ view, draft, onChange }: { view: FleetStepView; draft: Record<string, string>; onChange: (id: string, value: string) => void }) {
  return (
    <>
      {view.fields.map((f) =>
        f.kind === "choice" ? (
          <fieldset key={f.id} className="field fleet-guide-choice">
            <legend className="field-label">{f.label}</legend>
            {(f.options ?? []).map((o) => (
              <label key={o.value} className={`fleet-guide-option${o.disabled ? " disabled" : ""}`}>
                <input type="radio" name={f.id} value={o.value} checked={draft[f.id] === o.value} disabled={o.disabled} onChange={() => onChange(f.id, o.value)} />
                <span>
                  {o.label}
                  {o.detail && <span className="fleet-muted"> · {o.detail}</span>}
                </span>
              </label>
            ))}
            {f.hint && <span className="field-hint">{f.hint}</span>}
          </fieldset>
        ) : (
          <label key={f.id} className="field">
            <span className="field-label">{f.label}</span>
            <input
              className={`field-input${f.kind === "secret" ? " mono" : ""}`}
              type={f.kind === "secret" ? "password" : "text"}
              autoComplete="off"
              value={draft[f.id] ?? ""}
              onChange={(e) => onChange(f.id, e.target.value)}
            />
            {f.hint && <span className="field-hint">{f.hint}</span>}
          </label>
        ),
      )}
    </>
  );
}

/** Renders whatever step the Controller sends; it knows nothing about any particular guide. */
export function GuideCard({ model, session, send }: { model: FleetModel; session: FleetGuideSession; send: FleetSend }) {
  const [draft, setDraft] = useState(() => initialDraft(session.view));
  const [error, setError] = useState<string | null>(null);
  const guide = model.guideCatalog?.find((g) => g.id === session.guide);
  const { view, status } = session;

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(message(e, "The Controller didn't take that."));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (status === "ask") void act(() => send("GuideInput", { sessionId: session.id, input: draft }));
  };

  return (
    <form className="fleet-agent-card fleet-agent-form fleet-guide" onSubmit={submit} aria-label={`Add runner: ${guide?.title ?? session.guide}`}>
      <div className="fleet-guide-head">
        <span className="fleet-muted">Add runner · {guide?.title ?? session.guide}</span>
        <button type="button" className="fleet-icon-btn" aria-label="Cancel guide" title="Cancel" onClick={() => void act(() => send("CancelGuide", { sessionId: session.id }))}>
          <X size={14} />
        </button>
      </div>
      <h3 className="fleet-agent-name">{view.title}</h3>
      {view.body && <p className="field-hint">{view.body}</p>}
      {status === "working" && (
        <p className="fleet-guide-progress" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" /> {view.progress ?? "Working…"}
        </p>
      )}
      {status === "ask" && <StepFields view={view} draft={draft} onChange={(id, value) => setDraft((d) => ({ ...d, [id]: value }))} />}
      {(session.error ?? error) && (
        <div className="schedule-editor-error fleet-guide-error" role="alert">
          {session.error ?? error}
        </div>
      )}
      <div className="fleet-agent-run-actions">
        {status === "failed" && (
          <button type="button" className="btn-secondary fleet-small-btn" onClick={() => void act(() => send("GuideRetry", { sessionId: session.id }))}>
            <RotateCcw size={13} /> Retry
          </button>
        )}
        {status === "ask" && view.submit && (
          <button type="submit" className="btn-primary fleet-small-btn">
            {view.submit}
          </button>
        )}
      </div>
    </form>
  );
}

/** Removing a guide-made runner asks whether to also undo what the guide set up. */
export function RemoveRunnerDialog({
  runner,
  agentCount,
  onCancel,
  onRemove,
}: {
  runner: FleetRunner;
  agentCount: number;
  onCancel: () => void;
  onRemove: (teardown: boolean) => void;
}) {
  const teardown = runner.origin?.teardown;
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onCancel()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content className="sidebar-modal">
          <DialogPrimitive.Title className="sidebar-modal-title">Remove runner {runner.name}?</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sidebar-modal-body">
            {teardown
              ? `The Controller forgets ${runner.name} and its ${agentCount} agent(s). It can also ${teardown.label}.`
              : `The Controller forgets ${runner.name} and its ${agentCount} agent(s). The runner itself keeps running.`}
          </DialogPrimitive.Description>
          <div className="sidebar-modal-actions">
            <DialogPrimitive.Close asChild>
              <button type="button" className="sidebar-modal-btn">
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button type="button" className={`sidebar-modal-btn${teardown ? "" : " danger"}`} onClick={() => onRemove(false)}>
              {teardown ? "Only remove from fleet" : "Remove"}
            </button>
            {teardown && (
              <button type="button" className="sidebar-modal-btn danger" onClick={() => onRemove(true)}>
                Remove and {teardown.label}
              </button>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
