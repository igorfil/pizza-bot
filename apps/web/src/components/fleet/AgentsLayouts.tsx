import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlarmClock, Cpu, LoaderCircle, Plug, Plus, Settings, Trash2 } from "lucide-react";
import { AddAgentDialog, mcpServerSummary } from "./AddAgentDialog.js";
import { AgentActivity, AgentRuns, RunButton, RunStrip, ScheduleRow } from "./AgentParts.js";
import { AgentTypeIcon } from "./AgentTypeIcon.js";
import { RunnerDetailsDialog, RunnerPill, type RunnerTab } from "./FleetDetails.js";
import { useAppToast } from "../AppToast.js";
import type { FleetAgent, FleetModel, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { RemoveRunnerDialog } from "./GuideCard.js";
import type { OpenChat } from "./RunCard.js";
import {
  activeRun,
  agentNames,
  agentTone,
  inputLabel,
  isBuiltin,
  isRemoving,
  runnerLabel,
  runnerLocation,
  runnerStatusText,
  runsWith,
} from "./fleet-view-model.js";

export type LayoutProps = {
  model: FleetModel;
  runners: FleetRunner[];
  send: FleetSend;
  onOpenChat: OpenChat;
  onOpen: (agentKey: string) => void;
};

const agentsOn = (model: FleetModel, runner: FleetRunner): FleetAgent[] =>
  Object.values(model.agents ?? {})
    .filter((a) => a.runner === runner.name)
    .sort((a, b) => a.name.localeCompare(b.name));

/** The runner's name and state, its actions, and the dialogs they open. `compact` drops the words for a narrow column. */
function RunnerHead({
  model,
  runner,
  agents,
  send,
  compact = false,
  servers,
}: {
  model: FleetModel;
  runner: FleetRunner;
  agents: FleetAgent[];
  send: FleetSend;
  compact?: boolean;
  /** Show the runner's MCP servers, lighting the ones these ids name. */
  servers?: { lit: readonly string[] | null };
}) {
  const notify = useAppToast();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [details, setDetails] = useState<RunnerTab | null>(null);
  const down = runner.status === "unreachable";
  const change = runner.agentsChange ?? null;
  const adding = change?.action === "add" && change.error === null ? change : null;
  const name = runnerLabel(runner);
  const mcp = Object.keys(runner.mcpServers ?? {}).sort();
  const lit = servers?.lit ?? null;
  const chipClass = (id: string) => `fleet-mcp-chip${lit === null ? "" : lit.includes(id) ? " lit" : " faded"}`;
  return (
    <>
      <header className="fleet-runner-head">
        <h3 className="fleet-runner-name">
          <RunnerPill model={model} runner={runner} />
        </h3>
        {(!compact || down) && (
          <span className={down ? "fleet-tone-bad" : undefined}>
            {runnerLocation(runner)} · {runnerStatusText(model, runner)}
          </span>
        )}
        {!compact && down && runner.lastError && <span className="fleet-runner-error">{runner.lastError}</span>}
        <span className="fleet-agent-links-spacer" />
        <button
          type="button"
          className="fleet-ghost-btn"
          onClick={() => setAddingAgent(true)}
          disabled={change !== null && change.error === null}
          aria-label={adding ? `Adding ${agentNames(model, runner, adding.agents)} to ${name}` : `Add agent to ${name}`}
          title={compact ? "Add agent" : undefined}
        >
          {adding ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
          {!compact && (adding ? `Adding ${agentNames(model, runner, adding.agents)}…` : "Add agent")}
        </button>
        <button type="button" className="fleet-ghost-btn" onClick={() => setDetails("overview")} aria-label={`Edit runner ${name}`} title={compact ? "Edit runner" : undefined}>
          <Settings size={13} aria-hidden="true" />
          {!compact && "Edit"}
        </button>
        {!runner.local && (
          <button type="button" className="fleet-ghost-btn fleet-ghost-danger" onClick={() => setConfirmRemove(true)} aria-label={`Remove runner ${name}`} title="Remove runner">
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </header>
      {servers && mcp.length > 0 && (
        <ul className="fleet-mcp-chips" aria-label={`MCP servers on ${name}`}>
          {mcp.map((id) => (
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
                      title: `Removed ${name} and its agents`,
                      description: `EC2 instance ${runner.instanceId} was not terminated and keeps running. Terminate it in the AWS console if you no longer need it.`,
                      tone: "warning",
                    })
                  : notify({ title: `Removed ${name}`, tone: "success" }),
              )
              .catch((e: unknown) => notify({ title: "Couldn't remove the runner", description: e instanceof Error ? e.message : undefined, tone: "error" }));
          }}
        />
      )}
    </>
  );
}

const emptyText = (runner: FleetRunner): string =>
  runner.lastSeenAt === null ? "Waiting for the runner to list its agents…" : `No agents yet. Add one to choose what ${runnerLabel(runner)} runs.`;

function AgentMeta({ model, agent, runner }: { model: FleetModel; agent: FleetAgent; runner: FleetRunner }) {
  const engine = runsWith(model, runner, agent);
  return (
    <p className="fleet-agent-meta">
      {engine && (
        <span className="fleet-agent-chip" title={engine}>
          <Cpu size={12} aria-hidden="true" />
          <span className="fleet-agent-chip-text">{engine}</span>
        </span>
      )}
      {agent.schedule && (
        <span className="fleet-agent-chip" title={agent.schedule.prompt ? `${inputLabel(agent)}: ${agent.schedule.prompt}` : undefined}>
          <AlarmClock size={12} aria-hidden="true" /> Daily at {agent.schedule.at}
        </span>
      )}
    </p>
  );
}

export function AgentCard({
  model,
  agent,
  runner,
  send,
  onOpen,
  onHighlight,
}: {
  model: FleetModel;
  agent: FleetAgent;
  runner: FleetRunner;
  send: FleetSend;
  onOpen: (agentKey: string) => void;
  onHighlight?: (mcp: readonly string[] | null) => void;
}) {
  const removing = isRemoving(runner, agent);
  const down = runner.status === "unreachable";
  const highlight = () => isBuiltin(agent) && onHighlight?.(agent.mcp ?? []);
  const unhighlight = () => onHighlight?.(null);
  return (
    <article
      className={`fleet-agent-card${down ? " down" : ""}${removing ? " busy" : ""}${activeRun(model, agent.key) ? " active" : ""}`}
      aria-label={agent.name}
      aria-busy={removing || undefined}
      onMouseEnter={highlight}
      onMouseLeave={unhighlight}
      onFocus={highlight}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) unhighlight();
      }}
    >
      <h3 className="fleet-agent-name">
        <AgentTypeIcon agent={agent} runner={runner} />
        <button type="button" className="fleet-agent-open" onClick={() => onOpen(agent.key)} aria-label={`Open ${agent.name}`} title={agent.key}>
          {agent.name}
        </button>
      </h3>
      <p className="fleet-agent-desc" title={agent.description}>
        {agent.description}
      </p>
      <AgentMeta model={model} agent={agent} runner={runner} />
      <RunStrip model={model} agent={agent} />
      <footer className="fleet-agent-foot">
        <AgentActivity model={model} agent={agent} runner={runner} send={send} removing={removing} />
        <span className="fleet-agent-links-spacer" />
        {!removing && <RunButton model={model} agent={agent} runner={runner} send={send} />}
      </footer>
    </article>
  );
}

function RunnerCards({ model, runner, send, onOpen }: { model: FleetModel; runner: FleetRunner; send: FleetSend; onOpen: (agentKey: string) => void }) {
  const [lit, setLit] = useState<readonly string[] | null>(null);
  const agents = agentsOn(model, runner);
  return (
    <section className={`fleet-runner${runner.status === "unreachable" ? " down" : ""}`} aria-label={`Runner ${runnerLabel(runner)}`}>
      <RunnerHead model={model} runner={runner} agents={agents} send={send} servers={{ lit }} />
      {agents.length === 0 ? (
        <p className="fleet-muted fleet-runner-empty">{emptyText(runner)}</p>
      ) : (
        <div className="fleet-agent-grid">
          {agents.map((a) => (
            <AgentCard key={a.key} model={model} agent={a} runner={runner} send={send} onOpen={onOpen} onHighlight={setLit} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A card per agent, under its runner. */
export function CardsLayout({ model, runners, send, onOpen }: LayoutProps) {
  return (
    <>
      {runners.map((r) => (
        <RunnerCards key={r.name} model={model} runner={r} send={send} onOpen={onOpen} />
      ))}
    </>
  );
}

function AgentPanel({ model, agent, runner, send, onOpenChat, onOpen }: { model: FleetModel; agent: FleetAgent; runner: FleetRunner; send: FleetSend; onOpenChat: OpenChat; onOpen: (agentKey: string) => void }) {
  const removing = isRemoving(runner, agent);
  return (
    <article className="fleet-agent-panel" aria-label={agent.name}>
      <header className="fleet-agent-panel-head">
        <AgentTypeIcon agent={agent} runner={runner} size={18} />
        <h3 className="fleet-agent-panel-title">{agent.name}</h3>
        <span className="fleet-agent-links-spacer" />
        <button type="button" className="btn-secondary fleet-small-btn" onClick={() => onOpen(agent.key)} aria-label={`Open ${agent.name}`}>
          <Settings size={13} aria-hidden="true" /> Details
        </button>
        {!removing && <RunButton model={model} agent={agent} runner={runner} send={send} />}
      </header>
      {agent.description && <p className="fleet-detail-desc">{agent.description}</p>}
      <p className="fleet-agent-panel-activity">
        <AgentActivity model={model} agent={agent} runner={runner} send={send} removing={removing} />
      </p>
      <dl className="fleet-facts">
        <div className="fleet-fact">
          <dt>Runs with</dt>
          <dd>{runsWith(model, runner, agent) ?? "Its own command"}</dd>
        </div>
        <div className="fleet-fact">
          <dt>Runner</dt>
          <dd>
            <RunnerPill model={model} runner={runner} />
          </dd>
        </div>
        <div className="fleet-fact">
          <dt>Schedule</dt>
          <dd>
            <ScheduleRow key={`${agent.key}:${agent.schedule?.at ?? "none"}`} agent={agent} send={send} />
          </dd>
        </div>
        <div className="fleet-fact">
          <dt>History</dt>
          <dd>
            <RunStrip model={model} agent={agent} />
          </dd>
        </div>
      </dl>
      <section className="fleet-agent-panel-runs" aria-label={`Runs of ${agent.name}`}>
        <h4 className="fleet-agent-panel-sub">Runs</h4>
        <AgentRuns model={model} agent={agent} send={send} onOpenChat={onOpenChat} />
      </section>
    </article>
  );
}

/** Agents by runner on the left, the selected one in full on the right; ↑/↓ or j/k move. */
export function ListLayout({ model, runners, send, onOpenChat, onOpen }: LayoutProps) {
  const groups = runners.map((r) => ({ runner: r, agents: agentsOn(model, r) }));
  const order = groups.flatMap((g) => g.agents);
  const [selectedKey, setSelectedKey] = useState<string | null>(order[0]?.key ?? null);
  const selected = order.find((a) => a.key === selectedKey) ?? order[0];
  const selectedRunner = selected ? model.runners[selected.runner] : undefined;
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected?.key]);

  const onKeyDown = (e: KeyboardEvent) => {
    const by = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (by === 0 || !(e.target instanceof HTMLElement) || !e.target.closest(".fleet-agents-row")) return;
    e.preventDefault();
    const index = selected ? order.indexOf(selected) : -1;
    const next = order[Math.min(Math.max(index + by, 0), order.length - 1)];
    if (!next) return;
    setSelectedKey(next.key);
    list.current?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(next.key)}"]`)?.focus();
  };

  return (
    <div className="fleet-agents-split">
      <div ref={list} className="fleet-agents-list" onKeyDown={onKeyDown}>
        {groups.map(({ runner, agents }) => (
          <section key={runner.name} className="fleet-agents-list-group" aria-label={`Runner ${runnerLabel(runner)}`}>
            <RunnerHead model={model} runner={runner} agents={agents} send={send} compact />
            {agents.length === 0 ? (
              <p className="fleet-muted fleet-runner-empty">{emptyText(runner)}</p>
            ) : (
              <ul className="fleet-agents-rows">
                {agents.map((a) => {
                  const current = a.key === selected?.key;
                  return (
                    <li key={a.key}>
                      <button
                        type="button"
                        data-agent={a.key}
                        className={`fleet-inbox-row fleet-agents-row${current ? " active" : ""}`}
                        aria-current={current || undefined}
                        onClick={() => setSelectedKey(a.key)}
                      >
                        <AgentTypeIcon agent={a} runner={runner} size={16} />
                        <span className="fleet-run-line-text">
                          <span className="fleet-run-line-title">
                            <span className={`dot dot-${agentTone(model, runner, a.key)}`} aria-hidden="true" />
                            {a.name}
                          </span>
                          <span className="fleet-run-line-sub">{runsWith(model, runner, a) ?? a.description}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
      <div className="fleet-agents-detail">
        {selected && selectedRunner && <AgentPanel key={selected.key} model={model} agent={selected} runner={selectedRunner} send={send} onOpenChat={onOpenChat} onOpen={onOpen} />}
      </div>
    </div>
  );
}

const COLUMNS = 6;

/** One row per agent under a row per runner; a row opens the agent's details. */
export function TableLayout({ model, runners, send, onOpen }: LayoutProps) {
  return (
    <table className="fleet-inbox-table fleet-agents-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Runs with</th>
          <th>History</th>
          <th>Schedule</th>
          <th>Status</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      {runners.map((r) => {
        const agents = agentsOn(model, r);
        return (
          <tbody key={r.name} aria-label={`Runner ${runnerLabel(r)}`}>
            <tr className="fleet-agents-table-group">
              <th colSpan={COLUMNS} scope="colgroup">
                <RunnerHead model={model} runner={r} agents={agents} send={send} />
              </th>
            </tr>
            {agents.length === 0 && (
              <tr className="fleet-agents-table-empty">
                <td colSpan={COLUMNS} className="fleet-muted">
                  {emptyText(r)}
                </td>
              </tr>
            )}
            {agents.map((a) => {
              const removing = isRemoving(r, a);
              return (
                <tr key={a.key} className={removing ? "busy" : r.status === "unreachable" ? "down" : undefined} onClick={() => onOpen(a.key)}>
                  <td>
                    <div className="fleet-agents-table-name">
                      <span className="fleet-agents-table-title">
                        <AgentTypeIcon agent={a} runner={r} />
                        <button
                          type="button"
                          className="fleet-table-open"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(a.key);
                          }}
                          aria-label={`Open ${a.name}`}
                        >
                          {a.name}
                        </button>
                      </span>
                      <span className="fleet-agents-table-desc" title={a.description}>
                        {a.description}
                      </span>
                    </div>
                  </td>
                  <td className="fleet-muted fleet-agents-table-engine">{runsWith(model, r, a) ?? "—"}</td>
                  <td>
                    <RunStrip model={model} agent={a} />
                  </td>
                  <td className="fleet-muted">{a.schedule ? `Daily at ${a.schedule.at}` : "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <AgentActivity model={model} agent={a} runner={r} send={send} removing={removing} />
                  </td>
                  <td className="fleet-agents-table-actions" onClick={(e) => e.stopPropagation()}>
                    {!removing && <RunButton model={model} agent={a} runner={r} send={send} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
  );
}
