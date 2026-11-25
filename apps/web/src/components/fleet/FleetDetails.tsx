import { useState, type ReactNode } from "react";
import { Cloud, KeyRound, Laptop, LoaderCircle, Pencil, Plug, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { useAppToast } from "../AppToast.js";
import { EditAgentForm, mcpServerSummary } from "./AddAgentDialog.js";
import { McpServersPanel } from "./McpServersDialog.js";
import type { FleetAgent, FleetModel, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { FleetDialog } from "./GuideCard.js";
import { activeRun, ago, isBuiltin, runnerLabel, runnerLocation, runnerStatusText, runnerTone } from "./fleet-view-model.js";

export const placeIcon = (r: FleetRunner) => (/laptop|local/i.test(runnerLocation(r)) ? Laptop : Cloud);

function PluginList({ runner }: { runner: FleetRunner }) {
  const plugins = runner.plugins ?? [];
  if (plugins.length === 0) return <span className="fleet-muted">None</span>;
  return (
    <span className="fleet-plugin-list">
      {plugins.map((p) => (
        <span key={p.id} className={`fleet-pill fleet-pill-${p.healthy ? "ok" : "bad"}`} title={p.detail || undefined}>
          <span className={`dot dot-${p.healthy ? "ok" : "bad"}`} aria-hidden="true" />
          {p.name}
          {p.version && <span className="fleet-plugin-version">v{p.version}</span>}
          <span className="sr-only">{p.healthy ? " (healthy)" : ` (unavailable${p.detail ? `: ${p.detail}` : ""})`}</span>
        </span>
      ))}
    </span>
  );
}

const TRANSPORT: Record<FleetRunner["transport"], string> = { direct: "Direct", aws_ssm: "AWS SSM tunnel", ssh: "SSH tunnel" };

/** The runner's name, tinted by its health; the tooltip carries where it lives and its status in words. */
export function RunnerPill({ model, runner }: { model: FleetModel; runner: FleetRunner }) {
  const Where = placeIcon(runner);
  return (
    <span className={`fleet-pill fleet-pill-${runnerTone(runner.status)}`} title={`${runnerLocation(runner)} · ${runnerStatusText(model, runner)}`}>
      <Where size={13} aria-hidden="true" />
      {runnerLabel(runner)}
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

function SoonPanel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="fleet-soon-panel">
      {icon}
      <p className="fleet-soon-title">
        {title} <span className="fleet-soon">Coming soon</span>
      </p>
      <p className="fleet-muted">{children}</p>
    </div>
  );
}

function SecretsSoon({ runner }: { runner: FleetRunner }) {
  return (
    <SoonPanel icon={<KeyRound size={22} strokeWidth={1.5} aria-hidden="true" />} title="Secrets">
      Until then, write tokens as <code>{"${VAR}"}</code> in MCP server entries and set them in {runnerLabel(runner)}&apos;s environment.
    </SoonPanel>
  );
}

function PermissionsSoon({ agent }: { agent: FleetAgent }) {
  return (
    <SoonPanel icon={<ShieldCheck size={22} strokeWidth={1.5} aria-hidden="true" />} title="Permissions">
      Choose what {agent.name} may do on its own and what needs your approval first.
    </SoonPanel>
  );
}

const MAX_LABEL = 40;

/** The runner's name as the dialog title; the pencil turns it into an input. Enter or leaving saves, Esc cancels. */
function RunnerTitle({ runner, send }: { runner: FleetRunner; send: FleetSend }) {
  const notify = useAppToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = runnerLabel(runner);

  const save = async () => {
    if (draft === null || saving) return;
    const next = draft.trim();
    if (next === shown || (next === "" && !runner.label)) return setDraft(null);
    setSaving(true);
    try {
      await send("RenameRunner", { name: runner.name, label: next });
      setDraft(null);
    } catch (e) {
      notify({ title: "Couldn't rename the runner", description: e instanceof Error ? e.message : undefined, tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (draft === null) {
    return (
      <span className="fleet-title-edit">
        {shown}
        <button type="button" className="fleet-ghost-btn fleet-title-edit-btn" onClick={() => setDraft(shown)} aria-label={`Rename runner ${shown}`} title="Rename">
          <Pencil size={13} aria-hidden="true" />
        </button>
      </span>
    );
  }
  return (
    <span className="fleet-title-edit editing">
      <input
        className="fleet-title-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setDraft(null);
        }}
        maxLength={MAX_LABEL}
        placeholder={runner.name}
        aria-label={`Name for runner ${runner.name}; empty goes back to ${runner.name}`}
        data-escape-cancels=""
        disabled={saving}
        autoFocus
      />
      {saving && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
    </span>
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
          ["Built-in engine", runner.canCreateAgents ? "Pizza Bot" : "Not installed"],
          ["Harness plugins", <PluginList key="p" runner={runner} />],
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
        <p className="fleet-muted">{runnerLabel(runner)} runs no agents yet.</p>
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
      content: <McpServersPanel runner={runner} agents={agents} send={send} onClose={onClose} />,
    },
    { id: "secrets", label: "Secrets", content: <SecretsSoon runner={runner} /> },
  ];
  return (
    <FleetDialog title={<RunnerTitle key={runnerLabel(runner)} runner={runner} send={send} />} className="fleet-details" onClose={onClose}>
      <div className="fleet-details-meta">
        <span className={`dot dot-${runnerTone(runner.status)}`} aria-hidden="true" />
        <span className="fleet-muted">
          {runnerLocation(runner)} · {runnerStatusText(model, runner)}
        </span>
      </div>
      <DetailTabs tabs={tabs} initial={initial} label={`${runnerLabel(runner)} details`} />
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
  const builtin = isBuiltin(agent);
  const editable = builtin && agent.created === true && agent.model !== undefined && !down;
  const harness = runner.plugins?.find((p) => p.id === agent.harness)?.name ?? agent.harness;
  const runBy = builtin ? "the built-in engine" : harness ? `the ${harness} harness` : "its own command";

  const overview = (
    <>
      {agent.description && <p className="fleet-detail-desc">{agent.description}</p>}
      <Facts
        rows={[
          ["Status", active ? `${active.statusText ?? active.state} · started ${ago(model.now, active.createdAt)}` : status],
          ["Runner", <RunnerPill key="r" model={model} runner={runner} />],
          ["Runs with", builtin ? "Built-in engine" : harness ? `${harness} harness` : "Its own command"],
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
      {!builtin
        ? `${agent.name} is run by ${runBy}, which manages its settings; there is nothing to set here.`
        : down
          ? `${runnerLabel(runner)} isn't reachable right now. You can change ${agent.name} once it's online.`
          : `${agent.name} ships with ${runnerLabel(runner)}; its settings live in its folder on that machine.`}
    </p>
  );
  const mcp = !builtin ? (
    <p className="fleet-muted">
      {agent.name} is run by {runBy} and brings its own tools. {runnerLabel(runner)}&apos;s MCP servers are only for its built-in agents.
    </p>
  ) : servers.length === 0 ? (
    <p className="fleet-muted">{runnerLabel(runner)} has no MCP servers yet.</p>
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
          { id: "mcp", label: "MCP servers", ...(builtin ? { count: used.length } : {}), content: mcp },
          { id: "permissions", label: "Permissions", content: <PermissionsSoon agent={agent} /> },
          { id: "secrets", label: "Secrets", content: <SecretsSoon runner={runner} /> },
        ]}
        initial="overview"
        label={`${agent.name} details`}
      />
    </FleetDialog>
  );
}
