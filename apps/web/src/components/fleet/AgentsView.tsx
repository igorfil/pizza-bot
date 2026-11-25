import { useEffect, useState, type FormEvent } from "react";
import { AlarmClock, ChevronDown, ChevronUp, LoaderCircle, Play, Plug, Plus, RotateCcw, Server, Settings, Square, Trash2, X } from "lucide-react";
import { AddAgentDialog, mcpServerSummary } from "./AddAgentDialog.js";
import { AgentDetailsDialog, RunnerDetailsDialog, RunnerPill, type RunnerTab } from "./FleetDetails.js";
import { useAppToast } from "../AppToast.js";
import type { FleetAgent, FleetModel, FleetRunner, FleetTask } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { AddRunnerDialog, DeleteAgentDialog, FleetDialog, RemoveRunnerDialog } from "./GuideCard.js";
import { RunDialog } from "./RunCard.js";
import {
  activeRun,
  agentNames,
  agentsOf,
  agentsSummary,
  ago,
  guideSessionsOf,
  guideStatusText,
  stuckFor,
  defaultInput,
  inputLabel,
  isFinished,
  runnerLabel,
  runnerLocation,
  runnerStatusText,
  runsOf,
  runStrip,
  stripSummary,
  taskTone,
} from "./fleet-view-model.js";

const INLINE_RUNS = 5;

const stripTone = (t: FleetTask) => (isFinished(t) ? taskTone(t.state) : "running");

export function AgentsView({ model, send, onOpenChat }: { model: FleetModel; send: FleetSend; onOpenChat: (chatId: string) => void }) {
  const notify = useAppToast();
  const [adding, setAdding] = useState(false);
  const [guide, setGuide] = useState<{ id: string; seen: boolean } | null>(null);
  const agents = agentsOf(model);
  const runners = Object.values(model.runners).sort((a, b) => a.name.localeCompare(b.name));
  const sessions = guideSessionsOf(model);
  const open = guide ? (sessions.find((s) => s.id === guide.id) ?? null) : null;

  // A started guide shows up with the next model frame; once seen, its disappearance means done or canceled.
  useEffect(() => {
    if (!guide) return;
    if (open && !guide.seen) setGuide({ id: guide.id, seen: true });
    if (!open && guide.seen) setGuide(null);
  }, [guide, open]);

  const close = () => {
    setAdding(false);
    setGuide(null);
  };

  return (
    <div className="fleet-agents">
      <header className="fleet-agents-head">
        <h2 className="fleet-agents-title">Agents</h2>
        <span className="fleet-muted">{agentsSummary(model)}</span>
        <span className="fleet-agent-links-spacer" />
        <button type="button" className="btn-secondary fleet-small-btn" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add runner
        </button>
      </header>

      {sessions.length > 0 && (
        <ul className="fleet-guide-rows" aria-label="Runners being added">
          {sessions.map((s) => (
            <li key={s.id} className={`fleet-guide-row${s.status === "failed" ? " failed" : ""}`}>
              {s.status === "working" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Server size={14} aria-hidden="true" />}
              <span>
                Adding runner · {model.guideCatalog?.find((g) => g.id === s.guide)?.title ?? s.guide}
              </span>
              <span className="fleet-muted fleet-guide-row-status">{guideStatusText(s)}</span>
              <span className="fleet-agent-links-spacer" />
              {(s.status === "failed" || stuckFor(model.now, s) !== null) && (
                <button
                  type="button"
                  className="fleet-link-btn"
                  onClick={() =>
                    void send("GuideRetry", { sessionId: s.id }).catch((e: unknown) =>
                      notify({ title: "Couldn't retry the step", description: e instanceof Error ? e.message : undefined, tone: "error" }),
                    )
                  }
                >
                  <RotateCcw size={12} /> Retry
                </button>
              )}
              <button type="button" className="fleet-link-btn" onClick={() => setGuide({ id: s.id, seen: true })}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}

      {runners.map((r) => (
        <RunnerGroup key={r.name} model={model} runner={r} agents={agents.filter((a) => a.runner === r.name)} send={send} onOpenChat={onOpenChat} />
      ))}

      {runners.length === 0 && sessions.length === 0 && (
        <button type="button" className="fleet-agent-card fleet-agent-add" onClick={() => setAdding(true)}>
          <Plus size={22} strokeWidth={1.5} />
          Add your first runner
          <span className="fleet-muted">A runner is a machine that hosts your agents.</span>
        </button>
      )}

      {(adding || guide) && (
        <AddRunnerDialog
          model={model}
          session={open}
          send={send}
          onStarted={(id) => {
            setAdding(false);
            if (id) setGuide({ id, seen: false });
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

export function RunnerGroup({
  model,
  runner,
  agents,
  send,
  onOpenChat,
}: {
  model: FleetModel;
  runner: FleetRunner;
  agents: FleetAgent[];
  send: FleetSend;
  onOpenChat: (chatId: string) => void;
}) {
  const notify = useAppToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [details, setDetails] = useState<RunnerTab | null>(null);
  const [lit, setLit] = useState<readonly string[] | null>(null);
  const servers = Object.keys(runner.mcpServers ?? {}).sort();
  const down = runner.status === "unreachable";
  const change = runner.agentsChange ?? null;
  const adding = change?.action === "add" && change.error === null ? change : null;
  const chipClass = (id: string) => `fleet-mcp-chip${lit === null ? "" : lit.includes(id) ? " lit" : " faded"}`;
  return (
    <section className={`fleet-runner${down ? " down" : ""}`} aria-label={`Runner ${runnerLabel(runner)}`}>
      <header className="fleet-runner-head">
        <h3 className="fleet-runner-name">
          <RunnerPill model={model} runner={runner} />
        </h3>
        <span className={down ? "fleet-tone-bad" : "fleet-hover-reveal"}>
          {runnerLocation(runner)} · {runnerStatusText(model, runner)}
        </span>
        {down && runner.lastError && <span className="fleet-runner-error">{runner.lastError}</span>}
        <span className="fleet-agent-links-spacer" />
        <span className="fleet-hover-actions">
          <button type="button" className="fleet-ghost-btn" onClick={() => setDetails("overview")} aria-label={`Edit runner ${runnerLabel(runner)}`}>
            <Settings size={13} aria-hidden="true" /> Edit
          </button>
          {!runner.local && (
            <button
              type="button"
              className="fleet-ghost-btn fleet-ghost-danger"
              onClick={() => setConfirmRemove(true)}
              aria-label={`Remove runner ${runnerLabel(runner)}`}
              title="Remove runner"
            >
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </header>
      {servers.length > 0 && (
        <ul className="fleet-mcp-chips" aria-label={`MCP servers on ${runnerLabel(runner)}`}>
          {servers.map((id) => (
            <li key={id}>
              <button type="button" className={chipClass(id)} onClick={() => setDetails("mcp")} title={`${id}: ${mcpServerSummary(runner.mcpServers?.[id] ?? {})}`}>
                <Plug size={12} aria-hidden="true" /> {id}
              </button>
            </li>
          ))}
        </ul>
      )}
      {change?.error && (
        <p className="fleet-runner-change fleet-tone-bad" role="alert">
          Couldn't {change.action} {agentNames(model, runner, change.agents)}: {change.error}
        </p>
      )}
      {agents.length === 0 && runner.lastSeenAt === null ? (
        <p className="fleet-muted fleet-runner-empty">Waiting for the runner to list its agents…</p>
      ) : (
        <div className="fleet-agent-grid">
          {agents.map((a) => (
            <AgentCard
              key={a.key}
              model={model}
              agent={a}
              runner={runner}
              send={send}
              onOpenChat={onOpenChat}
              onHighlight={setLit}
              removing={change?.action === "remove" && change.error === null && change.agents.includes(a.name)}
            />
          ))}
          <button
            type="button"
            className="fleet-agent-card fleet-agent-add"
            onClick={() => setAddingAgent(true)}
            disabled={change !== null && change.error === null}
            aria-label={adding ? `Adding ${agentNames(model, runner, adding.agents)} to ${runnerLabel(runner)}` : `Add agent to ${runnerLabel(runner)}`}
          >
            {adding ? <LoaderCircle size={22} strokeWidth={1.5} className="spin" /> : <Plus size={22} strokeWidth={1.5} />}
            {adding ? `Adding ${agentNames(model, runner, adding.agents)}…` : "Add agent"}
            {agents.length === 0 && !adding && <span className="fleet-muted">Choose what {runnerLabel(runner)} runs.</span>}
          </button>
        </div>
      )}
      {details && (
        <RunnerDetailsDialog
          model={model}
          runner={runner}
          agents={agents}
          send={send}
          initial={details}
          onAddAgent={() => {
            setDetails(null);
            setAddingAgent(true);
          }}
          onRemove={() => {
            setDetails(null);
            setConfirmRemove(true);
          }}
          onClose={() => setDetails(null)}
        />
      )}
      {addingAgent && <AddAgentDialog model={model} runner={runner} send={send} onClose={() => setAddingAgent(false)} />}
      {confirmRemove && (
        <RemoveRunnerDialog
          runner={runner}
          agentCount={agents.length}
          onCancel={() => setConfirmRemove(false)}
          onRemove={(teardown) => {
            setConfirmRemove(false);
            send("RemoveRunner", { name: runner.name, teardown })
              .then(() =>
                runner.instanceId
                  ? notify({
                      title: `Removed ${runnerLabel(runner)} and its agents`,
                      description: `EC2 instance ${runner.instanceId} was not terminated and keeps running. Terminate it in the AWS console if you no longer need it.`,
                      tone: "warning",
                    })
                  : notify({ title: `Removed ${runnerLabel(runner)}`, tone: "success" }),
              )
              .catch((e: unknown) => notify({ title: "Couldn't remove the runner", description: e instanceof Error ? e.message : undefined, tone: "error" }));
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
  onOpenChat,
  onHighlight,
  removing = false,
}: {
  model: FleetModel;
  agent: FleetAgent;
  runner: FleetRunner;
  send: FleetSend;
  onOpenChat: (chatId: string) => void;
  onHighlight?: (mcp: readonly string[] | null) => void;
  removing?: boolean;
}) {
  const notify = useAppToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [details, setDetails] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [allRuns, setAllRuns] = useState(false);
  const runs = runsOf(model, agent.key);
  const openTask = openTaskId ? model.tasks[openTaskId] : undefined;
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

  const remove = () => {
    setConfirmDelete(false);
    send("DeleteAgent", { agent: agent.key }).catch((e: unknown) =>
      notify({ title: `Couldn't remove ${agent.name}`, description: e instanceof Error ? e.message : undefined, tone: "error" }),
    );
  };

  const highlight = () => onHighlight?.(agent.mcp ?? []);
  const unhighlight = () => onHighlight?.(null);

  return (
    <article
      className={`fleet-agent-card${down ? " down" : ""}${removing ? " removing" : ""}${active ? " active" : ""}`}
      aria-label={agent.name}
      aria-busy={removing || undefined}
      onMouseEnter={highlight}
      onMouseLeave={unhighlight}
      onFocus={highlight}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) unhighlight();
      }}
    >
      <header className="fleet-agent-head">
        <h3 className="fleet-agent-name" title={agent.key}>
          {agent.name}
        </h3>
        {!removing && (
          <span className="fleet-hover-actions">
            <button type="button" className="fleet-ghost-btn" onClick={() => setDetails(true)} aria-label={`Edit agent ${agent.name}`}>
              <Settings size={13} aria-hidden="true" /> Edit
            </button>
            {!down && (
              <button
                type="button"
                className="fleet-agent-delete"
                onClick={() => setConfirmDelete(true)}
                disabled={!!active}
                aria-label={`${agent.created ? "Delete" : "Remove"} agent ${agent.name}`}
                title={active ? "Wait for the run to finish, or cancel it, before removing the agent" : agent.created ? "Delete agent" : "Remove agent"}
              >
                <Trash2 size={13} />
              </button>
            )}
          </span>
        )}
      </header>
      {details && (
        <AgentDetailsDialog
          model={model}
          agent={agent}
          runner={runner}
          send={send}
          onDelete={
            down
              ? null
              : () => {
                  setDetails(false);
                  setConfirmDelete(true);
                }
          }
          onClose={() => setDetails(false)}
        />
      )}
      {removing && (
        <p className="fleet-agent-live" role="status">
          <LoaderCircle size={13} className="spin" aria-hidden="true" /> Removing…
        </p>
      )}
      {confirmDelete && <DeleteAgentDialog agent={agent} runner={runner} onCancel={() => setConfirmDelete(false)} onConfirm={remove} />}
      <p className="fleet-agent-desc">{agent.description}</p>

      {down ? (
        <p className="fleet-agent-down">Runner unreachable</p>
      ) : active ? (
        <p className="fleet-agent-live">
          <LoaderCircle size={13} className="spin" aria-hidden="true" /> {active.statusText ?? active.state}
          <button type="button" className="fleet-link-btn" onClick={() => void cancel(active)}>
            <Square size={11} /> cancel
          </button>
        </p>
      ) : null}

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
          Runs {showRuns ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="fleet-agent-links-spacer" />
        {!running && (
          <button type="button" className="btn-secondary fleet-small-btn" onClick={openRun} disabled={!!active || down}>
            <Play size={13} /> Run
          </button>
        )}
      </footer>

      {showRuns && <InlineRuns model={model} runs={runs.slice(0, INLINE_RUNS)} onOpen={setOpenTaskId} />}
      {showRuns && runs.length > INLINE_RUNS && (
        <button type="button" className="fleet-link-btn fleet-all-runs" onClick={() => setAllRuns(true)}>
          Show all {runs.length} runs
        </button>
      )}
      {allRuns && (
        <FleetDialog title={`${agent.name}: all runs`} onClose={() => setAllRuns(false)}>
          <InlineRuns model={model} runs={runs} onOpen={setOpenTaskId} />
        </FleetDialog>
      )}
      {openTask && <RunDialog model={model} task={openTask} send={send} onOpenChat={onOpenChat} onClose={() => setOpenTaskId(null)} />}
    </article>
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
      notify({ title: "Couldn't save the schedule", description: e instanceof Error ? e.message : undefined, tone: "error" });
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
