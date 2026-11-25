import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Circle, LoaderCircle, Minus, RotateCcw, TriangleAlert, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { FleetAgent, FleetChecklistItem, FleetGuideSession, FleetModel, FleetRunner, FleetStepView } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { duration, initialDraft, runnerLabel, stuckFor } from "./fleet-view-model.js";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** A wide modal for the Fleet page's multi-field flows; closing it never cancels anything. */
export function FleetDialog({ title, className, onClose, children }: { title: ReactNode; className?: string; onClose: () => void; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content
          className={`sidebar-modal sidebar-modal--wide fleet-dialog${className ? ` ${className}` : ""}`}
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (e.target instanceof Element && e.target.closest("[data-escape-cancels]")) e.preventDefault();
          }}
        >
          <div className="fleet-dialog-head">
            <DialogPrimitive.Title className="sidebar-modal-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button type="button" className="fleet-icon-btn fleet-dialog-close" aria-label="Close">
                <X size={14} />
              </button>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** "Add runner": the guides the Controller offers. Picking one starts a session in the Controller. */
export function GuidePicker({ model, send, onStarted }: { model: FleetModel; send: FleetSend; onStarted: (sessionId: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const guides = model.guideCatalog ?? [];

  const start = async (guide: string) => {
    setStarting(guide);
    setError(null);
    try {
      onStarted(await send("StartGuide", { guide }));
    } catch (e) {
      setError(message(e, "Couldn't start the guide."));
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className="fleet-guide" role="group" aria-label="Where should the runner live?">
      <p className="field-hint">Where should the runner live?</p>
      {guides.length === 0 && <p className="fleet-muted">This Controller offers no guides.</p>}
      <div className="fleet-guide-options">
        {guides.map((g) => (
          <button
            key={g.id}
            type="button"
            className={`fleet-guide-pick${g.comingSoon ? " soon" : ""}`}
            disabled={starting !== null || g.comingSoon === true}
            onClick={() => void start(g.id)}
          >
            <span className="fleet-guide-pick-title">
              {starting === g.id && <LoaderCircle size={13} className="spin" aria-hidden="true" />} {g.title}
              {g.comingSoon && <span className="fleet-soon">Coming soon</span>}
            </span>
            <span className="fleet-muted">{g.description}</span>
          </button>
        ))}
      </div>
      {error && (
        <div className="schedule-editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function Stepper({ steps }: { steps: NonNullable<FleetStepView["steps"]> }) {
  return (
    <ol className="fleet-stepper" aria-label="Steps">
      {steps.labels.map((label, i) => (
        <li key={label} className={i < steps.current ? "done" : i === steps.current ? "current" : undefined} aria-current={i === steps.current ? "step" : undefined}>
          <span className="fleet-stepper-n" aria-hidden="true">
            {i < steps.current ? <Check size={11} /> : i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** A radio or checkbox drawn as a card; the native input stays for keyboard and screen readers. */
export function ChoiceCard({
  type,
  name,
  value,
  checked,
  disabled,
  title,
  detail,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  title: string;
  detail?: string;
  onChange: () => void;
}) {
  return (
    <label className={`fleet-choice${checked ? " checked" : ""}${disabled ? " disabled" : ""}`}>
      <input className="fleet-choice-input" type={type} name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} />
      <span className={`fleet-choice-mark ${type}`} aria-hidden="true">
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <span className="fleet-choice-title">{title}</span>
      {detail && <span className="fleet-choice-detail">{detail}</span>}
    </label>
  );
}

const CHECK_ICONS: Record<FleetChecklistItem["state"], ReactNode> = {
  done: <Check size={12} strokeWidth={3} />,
  current: <LoaderCircle size={14} className="spin" />,
  pending: <Circle size={8} />,
  skipped: <Minus size={12} />,
  failed: <X size={12} strokeWidth={3} />,
};

const CHECK_WORDS: Record<FleetChecklistItem["state"], string> = {
  done: "done",
  current: "in progress",
  pending: "to do",
  skipped: "skipped",
  failed: "failed",
};

function Checklist({ items }: { items: FleetChecklistItem[] }) {
  return (
    <ol className="fleet-checklist" aria-label="Set-up steps">
      {items.map((item) => (
        <li key={item.label} className={item.state} aria-current={item.state === "current" ? "step" : undefined}>
          <span className="fleet-checklist-icon" aria-hidden="true">
            {CHECK_ICONS[item.state]}
          </span>
          <span className="fleet-checklist-text">
            <span className="fleet-checklist-label">
              {item.label}
              <span className="sr-only"> ({CHECK_WORDS[item.state]})</span>
            </span>
            {item.detail && <span className="fleet-checklist-detail">{item.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepFields({ view, draft, onChange }: { view: FleetStepView; draft: Record<string, string>; onChange: (id: string, value: string) => void }) {
  return (
    <>
      {view.fields.map((f) =>
        f.kind === "choice" ? (
          <fieldset key={f.id} className="fleet-choice-field">
            <legend className="field-label fleet-choice-legend">{f.label}</legend>
            <div className="fleet-choice-grid">
              {(f.options ?? []).map((o) => (
                <ChoiceCard
                  key={o.value}
                  type="radio"
                  name={f.id}
                  value={o.value}
                  checked={draft[f.id] === o.value}
                  disabled={o.disabled ?? false}
                  title={o.label}
                  {...(o.detail ? { detail: o.detail } : {})}
                  onChange={() => onChange(f.id, o.value)}
                />
              ))}
            </div>
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
export function GuideCard({ session, send, now = 0 }: { session: FleetGuideSession; send: FleetSend; now?: number }) {
  const [draft, setDraft] = useState(() => initialDraft(session.view));
  const [error, setError] = useState<string | null>(null);
  const { view, status } = session;
  const stuck = stuckFor(now, session);

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
    <form className="fleet-guide" onSubmit={submit} aria-label={view.title}>
      {view.steps && <Stepper steps={view.steps} />}
      <h3 className="fleet-agent-name">{view.title}</h3>
      {view.body && !view.checklist && <p className="field-hint">{view.body}</p>}
      {view.checklist && <Checklist items={view.checklist} />}
      {status === "working" && !view.checklist && (
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
      {stuck !== null && (
        <p className="fleet-guide-stuck" role="status">
          No progress for {duration(stuck)}. If this step seems stuck, retry it; set-up steps are safe to repeat.
        </p>
      )}
      <div className="fleet-guide-actions">
        <button type="button" className="fleet-link-btn fleet-link-danger" onClick={() => void act(() => send("CancelGuide", { sessionId: session.id }))}>
          Cancel setup
        </button>
        <span className="fleet-agent-links-spacer" />
        {(status === "failed" || stuck !== null) && (
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

/** The guide picker, then the guide it started, in one dialog. */
export function AddRunnerDialog({
  model,
  session,
  send,
  onStarted,
  onClose,
}: {
  model: FleetModel;
  session: FleetGuideSession | null;
  send: FleetSend;
  onStarted: (sessionId: string | null) => void;
  onClose: () => void;
}) {
  const guide = session ? model.guideCatalog?.find((g) => g.id === session.guide) : undefined;
  // `updatedAt` only moves on the Controller's tick, so two steps within one tick need the view in the key too.
  const stepKey = session ? `${session.id}:${session.updatedAt}:${session.status}:${session.view.title}:${session.view.fields.map((f) => f.id).join(",")}` : "";
  return (
    <FleetDialog title={session ? `Add runner · ${guide?.title ?? session.guide}` : "Add runner"} onClose={onClose}>
      {session ? (
        <GuideCard key={stepKey} session={session} send={send} now={model.now} />
      ) : (
        <GuidePicker model={model} send={send} onStarted={onStarted} />
      )}
    </FleetDialog>
  );
}

/** A created agent is deleted; one added through a plugin is removed from it. */
export function DeleteAgentDialog({ agent, runner, onCancel, onConfirm }: { agent: FleetAgent; runner: FleetRunner; onCancel: () => void; onConfirm: () => void }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onCancel()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content className="sidebar-modal">
          <DialogPrimitive.Title className="sidebar-modal-title">
            {agent.added ? "Remove" : "Delete"} {agent.name}?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sidebar-modal-body">
            {agent.added
              ? `This removes ${agent.name} from ${runnerLabel(runner)}. What it points to (its folder, image or runtime) isn't touched, and its past results stay in the Inbox.`
              : `This deletes ${agent.name} and its system prompt from ${runnerLabel(runner)}. Its past results stay in the Inbox.`}
          </DialogPrimitive.Description>
          <div className="sidebar-modal-actions">
            <DialogPrimitive.Close asChild>
              <button type="button" className="sidebar-modal-btn">
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button type="button" className="sidebar-modal-btn danger" onClick={onConfirm}>
              {agent.added ? "Remove agent" : "Delete agent"}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const agentsText = (n: number) => (n === 1 ? "its agent" : `its ${n} agents`);

/** An EC2 runner is uninstalled with every agent on it; the instance itself is never terminated. */
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
  const instance = runner.instanceId ?? null;
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onCancel()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content className="sidebar-modal sidebar-modal--wide">
          <DialogPrimitive.Title className="sidebar-modal-title">Remove runner {runnerLabel(runner)}?</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sidebar-modal-body">
            {instance
              ? `This uninstalls the runner from ${instance} and deletes ${agentsText(agentCount)} there, including agents you created. Runs in progress stop.`
              : `The Controller forgets ${runnerLabel(runner)} and ${agentsText(agentCount)}. The runner itself keeps running.`}
          </DialogPrimitive.Description>
          {instance && (
            <p className="fleet-remove-warning" role="note">
              <TriangleAlert size={15} aria-hidden="true" />
              <span>
                The EC2 instance <strong>{instance}</strong> is not terminated. It keeps running and costing money; terminate it in the AWS console if you no longer need it.
              </span>
            </p>
          )}
          <div className="sidebar-modal-actions">
            <DialogPrimitive.Close asChild>
              <button type="button" className="sidebar-modal-btn">
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button type="button" className="sidebar-modal-btn danger" onClick={() => onRemove(instance !== null)}>
              {instance ? "Remove runner and agents" : "Remove"}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
