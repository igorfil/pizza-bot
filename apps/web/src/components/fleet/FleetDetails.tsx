import type { ReactNode } from "react";
import { Cloud, KeyRound, Laptop, Plug, Plus, Trash2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { EditAgentForm, mcpServerSummary, runsTools } from "./AddAgentDialog.js";
import { McpServersPanel } from "./McpServersDialog.js";
import type { FleetAgent, FleetModel, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { FleetDialog } from "./GuideCard.js";
import { activeRun, ago, runnerLocation, runnerStatusText, runnerTone } from "./fleet-view-model.js";

export const placeIcon = (r: FleetRunner) => (/laptop|local/i.test(runnerLocation(r)) ? Laptop : Cloud);

const TRANSPORT: Record<FleetRunner["transport"], string> = { direct: "Direct", aws_ssm: "AWS SSM tunnel", ssh: "SSH tunnel" };

/** The runner's name, tinted by its health; the tooltip carries where it lives and its status in words. */
export function RunnerPill({ model, runner }: { model: FleetModel; runner: FleetRunner }) {
  const Where = placeIcon(runner);
  return (
    <span className={`fleet-pill fleet-pill-${runnerTone(runner.status)}`} title={`${runnerLocation(runner)} · ${runnerStatusText(model, runner)}`}>
      <Where size={13} aria-hidden="true" />
      {runner.name}
      <span className={`dot dot-${runnerTone(runner.status)}`} aria-hidden="true" />
    </span>
  );
}

type Tab = { id: string; label: string; count?: number; content: ReactNode };

function DetailTabs({ tabs, initial, label }: { tabs: Tab[]; initial: string; label: string }) {
  return (
    <Tabs.Root className="fleet-tabs" defaultValue={initial}>
      <Tabs.List className="fleet-tabs-list" aria-label={label}>
        {tabs.map((t) => (
          <Tabs.Trigger key={t.id} value={t.id} className="fleet-tab">
            {t.label}
            {t.count !== undefined && <span className="fleet-tab-count">{t.count}</span>}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.id} value={t.id} className="fleet-tab-panel">
          {t.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="fleet-facts">
      {rows.map(([k, v]) => (
        <div key={k} className="fleet-fact">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SecretsSoon({ runner }: { runner: FleetRunner }) {
  return (
    <div className="fleet-soon-panel">
      <KeyRound size={22} strokeWidth={1.5} aria-hidden="true" />
      <p className="fleet-soon-title">
        Secrets <span className="fleet-soon">Coming soon</span>
      </p>
      <p className="fleet-muted">
        Until then, write tokens as <code>{"${VAR}"}</code> in MCP server entries and set them in {runner.name}&apos;s environment.
      </p>
    </div>
  );
}

export type RunnerTab = "overview" | "agents" | "mcp" | "secrets";

export function RunnerDetailsDialog({
  model,
  runner,
  agents,
  send,
  initial,
  onAddAgent,
  onRemove,
  onClose,
}: {
  model: FleetModel;
  runner: FleetRunner;
  agents: FleetAgent[];
  send: FleetSend;
  initial: RunnerTab;
  onAddAgent: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const link = runner.link.state === "up" ? runner.link.url : (runner.link.error ?? "not connected");
  const overview = (
    <>
      <Facts
        rows={[
          ["Status", runnerStatusText(model, runner)],
          ["Runs on", runnerLocation(runner)],
          ["Connection", `${TRANSPORT[runner.transport]} · ${link}`],
          ...(runner.instanceId ? ([["EC2 instance", <code key="i">{runner.instanceId}</code>]] as [string, ReactNode][]) : []),
          ...(runner.origin ? ([["Set up with", runner.origin.summary]] as [string, ReactNode][]) : []),
          ["Harnesses", runner.harnesses?.length ? runner.harnesses.join(", ") : "—"],
          ...(runner.lastError ? ([["Last error", <span key="e" className="fleet-tone-bad">{runner.lastError}</span>]] as [string, ReactNode][]) : []),
        ]}
      />
      {!runner.local && (
        <div className="fleet-danger-zone">
          <span className="fleet-muted">Removing a runner also removes its agents from this page.</span>
          <button type="button" className="btn-secondary fleet-small-btn fleet-danger-btn" onClick={onRemove}>
            <Trash2 size={13} aria-hidden="true" /> Remove runner
          </button>
        </div>
      )}
    </>
  );
  const agentList = (
    <>
      {agents.length === 0 ? (
        <p className="fleet-muted">{runner.name} runs no agents yet.</p>
      ) : (
        <ul className="fleet-detail-list">
          {agents.map((a) => (
            <li key={a.key} className="fleet-detail-row">
              <span className="fleet-detail-row-name">{a.name}</span>
              <span className="fleet-muted fleet-detail-row-desc">{a.description}</span>
              {activeRun(model, a.key) && <span className="fleet-pill fleet-pill-info">running</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="fleet-guide-actions">
        <span className="fleet-agent-links-spacer" />
        <button type="button" className="btn-secondary fleet-small-btn" onClick={onAddAgent}>
          <Plus size={13} aria-hidden="true" /> Add agent
        </button>
      </div>
    </>
  );
  const tabs: Tab[] = [
    { id: "overview", label: "Overview", content: overview },
    { id: "agents", label: "Agents", count: agents.length, content: agentList },
    {
      id: "mcp",
      label: "MCP servers",
      count: Object.keys(runner.mcpServers ?? {}).length,
      content: runsTools(runner) ? (
        <McpServersPanel runner={runner} agents={agents} send={send} onClose={onClose} />
      ) : (
        <p className="fleet-muted">{runner.name}&apos;s harness doesn&apos;t give agents MCP servers.</p>
      ),
    },
    { id: "secrets", label: "Secrets", content: <SecretsSoon runner={runner} /> },
  ];
  return (
    <FleetDialog title={runner.name} className="fleet-details" onClose={onClose}>
      <div className="fleet-details-meta">
        <span className={`dot dot-${runnerTone(runner.status)}`} aria-hidden="true" />
        <span className="fleet-muted">
          {runnerLocation(runner)} · {runnerStatusText(model, runner)}
        </span>
      </div>
      <DetailTabs tabs={tabs} initial={initial} label={`${runner.name} details`} />
    </FleetDialog>
  );
}

export function AgentDetailsDialog({
  model,
  agent,
  runner,
  send,
  onDelete,
  onClose,
}: {
  model: FleetModel;
  agent: FleetAgent;
  runner: FleetRunner;
  send: FleetSend;
  onDelete: (() => void) | null;
  onClose: () => void;
}) {
  const active = activeRun(model, agent.key);
  const down = runner.status === "unreachable";
  const servers = Object.entries(runner.mcpServers ?? {});
  const used = agent.mcp ?? [];
  const status = down ? "offline" : active ? "running" : "idle";
  const tone = down ? "bad" : active ? "info" : "ok";
  const editable = agent.created === true && agent.model !== undefined && !down;

  const overview = (
    <>
      {agent.description && <p className="fleet-detail-desc">{agent.description}</p>}
      <Facts
        rows={[
          ["Status", active ? `${active.statusText ?? active.state} · started ${ago(model.now, active.createdAt)}` : status],
          ["Runner", <RunnerPill key="r" model={model} runner={runner} />],
          ["Harness", agent.harness ?? "—"],
          ...(agent.model ? ([["Model", model.agentModels?.find((m) => m.id === agent.model)?.label ?? agent.model]] as [string, ReactNode][]) : []),
          ["Schedule", agent.schedule ? `Daily at ${agent.schedule.at}` : "Not scheduled"],
          ...(agent.skills?.length ? ([["Skills", agent.skills.map((s) => s.name).join(", ")]] as [string, ReactNode][]) : []),
        ]}
      />
      {onDelete && (
        <div className="fleet-danger-zone">
          <span className="fleet-muted">{active ? "Wait for the run to finish, or cancel it, before removing the agent." : agent.created ? "Deletes the agent and its system prompt." : "The runner stops serving it; you can add it back later."}</span>
          <button type="button" className="btn-secondary fleet-small-btn fleet-danger-btn" onClick={onDelete} disabled={!!active}>
            <Trash2 size={13} aria-hidden="true" /> {agent.created ? "Delete agent" : "Remove agent"}
          </button>
        </div>
      )}
    </>
  );
  const settings = editable ? (
    <EditAgentForm model={model} agent={agent} send={send} onClose={onClose} />
  ) : (
    <p className="fleet-muted">
      {down
        ? `${runner.name} isn't reachable right now. You can change ${agent.name} once it's online.`
        : `${agent.name} ships with ${runner.name}; its settings live in its folder on that machine.`}
    </p>
  );
  const mcp = !runsTools(runner) ? (
    <p className="fleet-muted">{runner.name}&apos;s harness doesn&apos;t give agents MCP servers.</p>
  ) : servers.length === 0 ? (
    <p className="fleet-muted">{runner.name} has no MCP servers yet.</p>
  ) : (
    <>
      <ul className="fleet-detail-list">
        {servers.map(([id, entry]) => (
          <li key={id} className={`fleet-detail-row${used.includes(id) ? "" : " off"}`}>
            <Plug size={13} aria-hidden="true" />
            <span className="fleet-detail-row-name">{id}</span>
            <code className="fleet-mcp-cmd">{mcpServerSummary(entry)}</code>
            <span className={used.includes(id) ? "fleet-pill fleet-pill-ok" : "fleet-muted"}>{used.includes(id) ? "used" : "not used"}</span>
          </li>
        ))}
      </ul>
      {editable && <p className="field-hint">Pick which ones {agent.name} uses in Settings.</p>}
    </>
  );
  return (
    <FleetDialog title={agent.name} className="fleet-details" onClose={onClose}>
      <div className="fleet-details-meta">
        <span className={`fleet-pill fleet-pill-${tone}`}>
          <span className={`dot dot-${tone}`} aria-hidden="true" />
          {status}
        </span>
        <span className="fleet-muted">on</span>
        <RunnerPill model={model} runner={runner} />
      </div>
      <DetailTabs
        tabs={[
          { id: "overview", label: "Overview", content: overview },
          { id: "settings", label: "Settings", content: settings },
          { id: "mcp", label: "MCP servers", count: used.length, content: mcp },
          { id: "secrets", label: "Secrets", content: <SecretsSoon runner={runner} /> },
        ]}
        initial="overview"
        label={`${agent.name} details`}
      />
    </FleetDialog>
  );
}
