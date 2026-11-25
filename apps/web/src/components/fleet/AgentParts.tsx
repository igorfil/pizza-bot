// Agent pieces shared by the Agents layouts and the agent details dialog.
import { useState, type FormEvent } from "react";
import { Popover } from "radix-ui";
import { AlarmClock, LoaderCircle, Play, Square } from "lucide-react";
import { useAppToast } from "../AppToast.js";
import type { FleetAgent, FleetModel, FleetRunner, FleetTask } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { RunDialog, type OpenChat } from "./RunCard.js";
import { activeRun, ago, defaultInput, inputLabel, isFinished, lastFinishedRun, runsOf, runStrip, stripSummary, taskTone } from "./fleet-view-model.js";

const errorText = (e: unknown) => (e instanceof Error ? e.message : undefined);

export const stripTone = (t: FleetTask) => (isFinished(t) ? taskTone(t.state) : "running");

export function RunStrip({ model, agent }: { model: FleetModel; agent: FleetAgent }) {
  const strip = runStrip(model, agent.key);
  return (
    <div className="fleet-strip" role="img" aria-label={stripSummary(strip)}>
      {strip.length === 0 ? (
        <span className="fleet-muted">No runs yet</span>
      ) : (
        strip.map((t) => (
          <span
            key={t.id}
            className={`fleet-strip-cell fleet-strip-${stripTone(t)}`}
            aria-hidden="true"
            title={`${t.state} · ${ago(model.now, t.createdAt)}${t.prompt ? ` · ${t.prompt}` : ""}`}
          />
        ))
      )}
    </div>
  );
}

/** What the agent is doing right now, else when it last ran. */
export function AgentActivity({ model, agent, runner, send, removing = false }: { model: FleetModel; agent: FleetAgent; runner: FleetRunner; send: FleetSend; removing?: boolean }) {
  const notify = useAppToast();
  const active = activeRun(model, agent.key);
  const last = lastFinishedRun(model, agent.key);

  const cancel = async (task: FleetTask) => {
    try {
      await send("CancelTask", { taskId: task.id });
    } catch (e) {
      notify({ title: "Couldn't cancel the run", description: errorText(e), tone: "error" });
    }
  };

  if (removing)
    return (
      <span className="fleet-agent-live" role="status">
        <LoaderCircle size={13} className="spin" aria-hidden="true" /> Removing…
      </span>
    );
  if (runner.status === "unreachable") return <span className="fleet-agent-down">Runner unreachable</span>;
  if (active)
    return (
      <span className="fleet-agent-live">
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
        <span className="fleet-agent-live-text">{active.statusText ?? active.state}</span>
        <button type="button" className="fleet-link-btn" onClick={() => void cancel(active)}>
          <Square size={11} /> cancel
        </button>
      </span>
    );
  if (!last) return null;
  return (
    <span className="fleet-muted">
      {taskTone(last.state) === "bad" && <span className="fleet-tone-bad">{last.state} · </span>}
      Last run {ago(model.now, last.updatedAt)}
    </span>
  );
}

/** Run with an input asked for in a popover anchored to the button. */
export function RunButton({ model, agent, runner, send, disabled = false }: { model: FleetModel; agent: FleetAgent; runner: FleetRunner; send: FleetSend; disabled?: boolean }) {
  const notify = useAppToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const label = inputLabel(agent);
  const blocked = disabled || runner.status === "unreachable" || !!activeRun(model, agent.key);

  const toggle = (next: boolean) => {
    if (next) setInput(defaultInput(model, agent.key));
    setOpen(next);
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    try {
      await send("CreateTask", { agent: agent.key, prompt: input.trim() });
      setOpen(false);
      notify({ title: `Started ${agent.name}`, description: "The result will land in the Inbox.", tone: "success" });
    } catch (e) {
      notify({ title: `Couldn't start ${agent.name}`, description: errorText(e), tone: "error" });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={toggle}>
      <Popover.Trigger asChild>
        <button type="button" className="btn-secondary fleet-small-btn" disabled={blocked} aria-label={`Run ${agent.name}`}>
          <Play size={13} aria-hidden="true" /> Run
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="fleet-popover" align="end" sideOffset={6} collisionPadding={12}>
          <form className="fleet-agent-run" onSubmit={(e) => void start(e)}>
            <label className="field">
              <span className="field-label">{label}</span>
              {agent.input?.hint && <span className="field-hint">{agent.input.hint}</span>}
              <input className="field-input" value={input} onChange={(e) => setInput(e.target.value)} aria-label={`${label} for ${agent.name}`} autoFocus />
            </label>
            <div className="fleet-agent-run-actions">
              <Popover.Close asChild>
                <button type="button" className="btn-secondary fleet-small-btn" disabled={starting}>
                  Cancel
                </button>
              </Popover.Close>
              <button type="submit" className="btn-primary fleet-small-btn" disabled={starting}>
                {starting ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />} Run
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const DEFAULT_SCHEDULE = "07:30";

export function ScheduleRow({ agent, send }: { agent: FleetAgent; send: FleetSend }) {
  const notify = useAppToast();
  const [editing, setEditing] = useState(false);
  const [at, setAt] = useState(agent.schedule?.at ?? DEFAULT_SCHEDULE);
  const [prompt, setPrompt] = useState(agent.schedule?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const label = inputLabel(agent);

  const save = async (next: string | null) => {
    setSaving(true);
    try {
      await send("SetSchedule", { agent: agent.key, at: next ?? "", prompt: next ? prompt.trim() : (agent.schedule?.prompt ?? "") });
      setEditing(false);
      notify({ title: next ? `${agent.name} runs daily at ${next}` : `Turned off ${agent.name}'s schedule`, tone: "success" });
    } catch (e) {
      notify({ title: "Couldn't save the schedule", description: errorText(e), tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <p className="fleet-agent-schedule">
        <AlarmClock size={13} aria-hidden="true" />
        <span className="fleet-agent-schedule-text">
          {agent.schedule ? `Daily at ${agent.schedule.at}` : "Not scheduled"}
          {agent.schedule?.prompt && <span title={agent.schedule.prompt}> · {label}: {agent.schedule.prompt}</span>}
        </span>
        <button type="button" className="fleet-link-btn" onClick={() => setEditing(true)}>
          {agent.schedule ? "change" : "schedule"}
        </button>
      </p>
    );
  }

  return (
    <form
      className="fleet-agent-schedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(at);
      }}
    >
      <label className="fleet-agent-schedule-label">
        <AlarmClock size={13} aria-hidden="true" /> Daily at
        <input
          type="time"
          className="field-input fleet-time"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          aria-label={`Daily run time for ${agent.name}`}
          required
        />
      </label>
      <input
        className="field-input fleet-schedule-input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={`${label} (optional)`}
        aria-label={`${label} for scheduled runs of ${agent.name}`}
      />
      <span className="fleet-agent-links-spacer" />
      {agent.schedule && (
        <button type="button" className="fleet-link-btn" onClick={() => void save(null)} disabled={saving}>
          turn off
        </button>
      )}
      <button type="button" className="fleet-link-btn" onClick={() => setEditing(false)} disabled={saving}>
        cancel
      </button>
      <button type="submit" className="btn-primary fleet-small-btn" disabled={saving || !at}>
        Save
      </button>
    </form>
  );
}

export function InlineRuns({ model, runs, onOpen }: { model: FleetModel; runs: FleetTask[]; onOpen: (taskId: string) => void }) {
  if (runs.length === 0) return <p className="fleet-muted fleet-inline-runs">No runs yet.</p>;
  return (
    <ul className="fleet-inline-runs">
      {runs.map((t) => {
        const cells = (
          <>
            <span className={`fleet-strip-cell fleet-strip-${stripTone(t)}`} aria-hidden="true" />
            <span className={`fleet-state fleet-tone-${taskTone(t.state)}`}>{t.state}</span>
            <span className="fleet-muted">{ago(model.now, t.createdAt)}</span>
            <span className="fleet-inline-runs-input">{t.prompt || "(no input)"}</span>
          </>
        );
        return (
          <li key={t.id}>
            {isFinished(t) ? (
              <button type="button" className="fleet-inline-run" onClick={() => onOpen(t.id)} title="Open the result">
                {cells}
              </button>
            ) : (
              <div className="fleet-inline-run">{cells}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The agent's runs, newest first; a finished one opens in a dialog. */
export function AgentRuns({ model, agent, send, onOpenChat }: { model: FleetModel; agent: FleetAgent; send: FleetSend; onOpenChat: OpenChat }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? model.tasks[openId] : undefined;
  return (
    <>
      <InlineRuns model={model} runs={runsOf(model, agent.key)} onOpen={setOpenId} />
      {open && <RunDialog model={model} task={open} send={send} onOpenChat={onOpenChat} onClose={() => setOpenId(null)} />}
    </>
  );
}
