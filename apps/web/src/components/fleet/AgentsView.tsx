import { useState, type FormEvent } from "react";
import { AlarmClock, ChevronDown, ChevronUp, Cloud, Laptop, LoaderCircle, Play, Plus, Server, Square, Trash2, X } from "lucide-react";
import { useAppToast } from "../AppToast.js";
import type { FleetAgent, FleetModel, FleetRunner, FleetTask } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { GuideCard, GuidePicker, RemoveRunnerDialog } from "./GuideCard.js";
import {
  activeRun,
  agentsOf,
  ago,
  guideSessionsOf,
  defaultInput,
  inputLabel,
  isFinished,
  runnerHealth,
  runnerLocation,
  runnerTone,
  runsOf,
  runStrip,
  taskTone,
} from "./fleet-view-model.js";

const INLINE_RUNS = 5;

const stripTone = (t: FleetTask) => (isFinished(t) ? taskTone(t.state) : "running");

const placeIcon = (r: FleetRunner) => (/laptop|local/i.test(runnerLocation(r)) ? Laptop : Cloud);

export function AgentsView({ model, send }: { model: FleetModel; send: FleetSend }) {
  const [adding, setAdding] = useState(false);
  const agents = agentsOf(model);
  const runners = Object.values(model.runners).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="fleet-agents">
      {runners.map((r) => (
        <RunnerGroup key={r.name} model={model} runner={r} agents={agents.filter((a) => a.runner === r.name)} send={send} />
      ))}
      <div className="fleet-agent-grid">
        {guideSessionsOf(model).map((s) => (
          <GuideCard key={`${s.id}:${s.updatedAt}`} model={model} session={s} send={send} />
        ))}
        {adding ? (
          <GuidePicker model={model} send={send} onClose={() => setAdding(false)} />
        ) : (
          <button type="button" className="fleet-agent-card fleet-agent-add" onClick={() => setAdding(true)}>
            <Plus size={22} strokeWidth={1.5} />
            Add runner
          </button>
        )}
      </div>
    </div>
  );
}

export function RunnerGroup({
  model,
  runner,
  agents,
  send,
}: {
  model: FleetModel;
  runner: FleetRunner;
  agents: FleetAgent[];
  send: FleetSend;
}) {
  const notify = useAppToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const Where = placeIcon(runner);
  const down = runner.status === "unreachable";
  return (
    <section className={`fleet-runner${down ? " down" : ""}`} aria-label={`Runner ${runner.name}`}>
      <header className="fleet-runner-head">
        <Server size={15} aria-hidden="true" />
        <h3 className="fleet-runner-name">{runner.name}</h3>
        <span className={`dot dot-${runnerTone(runner.status)}`} title={runner.status} />
        <span className="fleet-runner-where">
          <Where size={14} aria-hidden="true" /> {runnerLocation(runner)}
        </span>
        <span className={down ? "fleet-tone-bad" : "fleet-muted"}>
          {down ? `unreachable · ${runnerHealth(model, runner)}` : runnerHealth(model, runner)}
        </span>
        {down && runner.lastError && <span className="fleet-runner-error">{runner.lastError}</span>}
        <span className="fleet-agent-links-spacer" />
        <button
          type="button"
          className="fleet-icon-btn fleet-agent-remove"
          onClick={() => setConfirmRemove(true)}
          aria-label={`Remove runner ${runner.name}`}
          title="Remove runner"
        >
          <Trash2 size={13} />
        </button>
      </header>
      <div className="fleet-agent-grid">
        {agents.length === 0 ? (
          <p className="fleet-muted">{runner.lastSeenAt === null ? "Waiting for the runner to list its agents…" : "This runner serves no agents."}</p>
        ) : (
          agents.map((a) => <AgentCard key={a.key} model={model} agent={a} runner={runner} send={send} />)
        )}
      </div>
      {confirmRemove && (
        <RemoveRunnerDialog
          runner={runner}
          agentCount={agents.length}
          onCancel={() => setConfirmRemove(false)}
          onRemove={(teardown) => {
            setConfirmRemove(false);
            void send("RemoveRunner", { name: runner.name, teardown }).catch((e: unknown) =>
              notify({ title: "Couldn't remove the runner", description: e instanceof Error ? e.message : undefined, tone: "error" }),
            );
          }}
        />
      )}
    </section>
  );
}

export function AgentCard({
  model,
  agent,
  runner,
  send,
}: {
  model: FleetModel;
  agent: FleetAgent;
  runner: FleetRunner;
  send: FleetSend;
}) {
  const notify = useAppToast();
  const [showRuns, setShowRuns] = useState(false);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const active = activeRun(model, agent.key);
  const strip = runStrip(model, agent.key);
  const down = runner.status === "unreachable";
  const label = inputLabel(agent);

  const openRun = () => {
    setInput(defaultInput(model, agent.key));
    setRunning(true);
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    try {
      await send("CreateTask", { agent: agent.key, prompt: input.trim() });
      setRunning(false);
      notify({ title: `Started ${agent.name}`, description: "The result will land in the Inbox.", tone: "success" });
    } catch (e) {
      notify({ title: `Couldn't start ${agent.name}`, description: e instanceof Error ? e.message : undefined, tone: "error" });
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (task: FleetTask) => {
    try {
      await send("CancelTask", { taskId: task.id });
    } catch (e) {
      notify({ title: "Couldn't cancel the run", description: e instanceof Error ? e.message : undefined, tone: "error" });
    }
  };

  return (
    <article className={`fleet-agent-card${down ? " down" : ""}`} aria-label={agent.name}>
      <header className="fleet-agent-head">
        <h3 className="fleet-agent-name">{agent.name}</h3>
        <span className="fleet-agent-id">{agent.key}</span>
      </header>
      <p className="fleet-agent-desc">{agent.description}</p>

      {down ? (
        <p className="fleet-agent-down">UNREACHABLE</p>
      ) : active ? (
        <p className="fleet-agent-live">
          <LoaderCircle size={13} className="spin" aria-hidden="true" /> {active.statusText ?? active.state}
          <button type="button" className="fleet-link-btn" onClick={() => void cancel(active)}>
            <Square size={11} /> cancel
          </button>
        </p>
      ) : null}

      <div className="fleet-strip" aria-label={`Last ${strip.length} runs`}>
        {strip.length === 0 ? (
          <span className="fleet-muted">No runs yet</span>
        ) : (
          strip.map((t) => (
            <span
              key={t.id}
              className={`fleet-strip-cell fleet-strip-${stripTone(t)}`}
              title={`${t.state} · ${ago(model.now, t.createdAt)}${t.prompt ? ` · ${t.prompt}` : ""}`}
            />
          ))
        )}
      </div>

      <ScheduleRow key={agent.schedule?.at ?? "none"} agent={agent} send={send} />

      {running && (
        <form className="fleet-agent-run" onSubmit={(e) => void start(e)}>
          <label className="field">
            <span className="field-label">{label}</span>
            {agent.input?.hint && <span className="field-hint">{agent.input.hint}</span>}
            <input
              className="field-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label={`${label} for ${agent.name}`}
              autoFocus
            />
          </label>
          <div className="fleet-agent-run-actions">
            <button type="button" className="btn-secondary fleet-small-btn" onClick={() => setRunning(false)} disabled={starting}>
              <X size={13} /> Close
            </button>
            <button type="submit" className="btn-primary fleet-small-btn" disabled={starting}>
              {starting ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />} Run
            </button>
          </div>
        </form>
      )}

      <footer className="fleet-agent-links">
        <button type="button" className="fleet-link-btn" onClick={() => setShowRuns((v) => !v)} aria-expanded={showRuns}>
          [runs] {showRuns ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button type="button" className="fleet-link-btn" disabled title="Evals are coming soon">
          [evals]
        </button>
        <span className="fleet-agent-links-spacer" />
        {!running && (
          <button type="button" className="btn-secondary fleet-small-btn" onClick={openRun} disabled={!!active || down}>
            <Play size={13} /> Run
          </button>
        )}
      </footer>

      {showRuns && <InlineRuns model={model} runs={runsOf(model, agent.key).slice(0, INLINE_RUNS)} />}
    </article>
  );
}

const DEFAULT_SCHEDULE = "07:30";

export function ScheduleRow({ agent, send }: { agent: FleetAgent; send: FleetSend }) {
  const notify = useAppToast();
  const [editing, setEditing] = useState(false);
  const [at, setAt] = useState(agent.schedule?.at ?? DEFAULT_SCHEDULE);
  const [saving, setSaving] = useState(false);

  const save = async (next: string | null) => {
    setSaving(true);
    try {
      await send("SetSchedule", { agent: agent.key, at: next ?? "", prompt: agent.schedule?.prompt ?? "" });
      setEditing(false);
      notify({ title: next ? `${agent.name} runs daily at ${next}` : `Turned off ${agent.name}'s schedule`, tone: "success" });
    } catch (e) {
      notify({ title: "Couldn't save the schedule", description: e instanceof Error ? e.message : undefined, tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <p className="fleet-agent-schedule">
        <AlarmClock size={13} aria-hidden="true" />
        <span>{agent.schedule ? `Daily at ${agent.schedule.at}` : "Not scheduled"}</span>
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

function InlineRuns({ model, runs }: { model: FleetModel; runs: FleetTask[] }) {
  if (runs.length === 0) return <p className="fleet-muted fleet-inline-runs">No runs yet.</p>;
  return (
    <ul className="fleet-inline-runs">
      {runs.map((t) => (
        <li key={t.id}>
          <span className={`fleet-strip-cell fleet-strip-${stripTone(t)}`} aria-hidden="true" />
          <span className={`fleet-state fleet-tone-${taskTone(t.state)}`}>{t.state}</span>
          <span className="fleet-muted">{ago(model.now, t.createdAt)}</span>
          <span className="fleet-inline-runs-input">{t.prompt || "(no input)"}</span>
        </li>
      ))}
    </ul>
  );
}
