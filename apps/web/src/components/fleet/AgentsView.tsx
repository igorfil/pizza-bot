import { useEffect, useState } from "react";
import { Columns2, LayoutGrid, LoaderCircle, Plus, RotateCcw, Server, Table2, type LucideIcon } from "lucide-react";
import { AgentDetailsDialog } from "./FleetDetails.js";
import { useAppToast } from "../AppToast.js";
import type { FleetAgent, FleetModel, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { AddRunnerDialog, DeleteAgentDialog } from "./GuideCard.js";
import { CardsLayout, ListLayout, TableLayout } from "./AgentsLayouts.js";
import { save } from "./InboxView.js";
import type { OpenChat } from "./RunCard.js";
import { agentsSummary, guideSessionsOf, guideStatusText, stuckFor } from "./fleet-view-model.js";

export type AgentsLayout = "cards" | "list" | "table";

export const AGENTS_LAYOUTS: { id: AgentsLayout; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "cards", label: "Cards", hint: "A card per agent, grouped by runner", icon: LayoutGrid },
  { id: "list", label: "List", hint: "Agents and the selected one side by side; ↑/↓ or j/k to move", icon: Columns2 },
  { id: "table", label: "Table", hint: "One row per agent", icon: Table2 },
];

const LAYOUT_KEY = "pizza.fleet.agentsLayout";

const loadAgentsLayout = (): AgentsLayout => {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(LAYOUT_KEY);
  return AGENTS_LAYOUTS.find((l) => l.id === saved)?.id ?? "cards";
};

function AgentDetails({ model, agent, runner, send, onOpenChat, onClose }: { model: FleetModel; agent: FleetAgent; runner: FleetRunner; send: FleetSend; onOpenChat: OpenChat; onClose: () => void }) {
  const notify = useAppToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = () => {
    setConfirmDelete(false);
    onClose();
    send("DeleteAgent", { agent: agent.key }).catch((e: unknown) =>
      notify({ title: `Couldn't remove ${agent.name}`, description: e instanceof Error ? e.message : undefined, tone: "error" }),
    );
  };
  return (
    <>
      <AgentDetailsDialog
        model={model}
        agent={agent}
        runner={runner}
        send={send}
        onOpenChat={onOpenChat}
        onDelete={runner.status === "unreachable" ? null : () => setConfirmDelete(true)}
        onClose={onClose}
      />
      {confirmDelete && <DeleteAgentDialog agent={agent} runner={runner} onCancel={() => setConfirmDelete(false)} onConfirm={remove} />}
    </>
  );
}

export function AgentsView({ model, send, onOpenChat, initialLayout }: { model: FleetModel; send: FleetSend; onOpenChat: OpenChat; initialLayout?: AgentsLayout }) {
  const notify = useAppToast();
  const [layout, setLayout] = useState<AgentsLayout>(() => initialLayout ?? loadAgentsLayout());
  const [adding, setAdding] = useState(false);
  const [guide, setGuide] = useState<{ id: string; seen: boolean } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const runners = Object.values(model.runners).sort((a, b) => a.name.localeCompare(b.name));
  const sessions = guideSessionsOf(model);
  const open = guide ? (sessions.find((s) => s.id === guide.id) ?? null) : null;
  const openAgent = openKey ? model.agents?.[openKey] : undefined;
  const openRunner = openAgent ? model.runners[openAgent.runner] : undefined;

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

  const choose = (next: AgentsLayout) => {
    setLayout(next);
    save(LAYOUT_KEY, next);
  };

  const props = { model, runners, send, onOpenChat, onOpen: setOpenKey };

  return (
    <div className={`fleet-agents fleet-agents--${layout}`}>
      <header className="fleet-agents-head">
        <h2 className="fleet-agents-title">Agents</h2>
        <span className="fleet-muted">{agentsSummary(model)}</span>
        <span className="fleet-agent-links-spacer" />
        {runners.length > 0 && (
          <div className="fleet-segmented fleet-layout-switcher" role="group" aria-label="Agents layout">
            {AGENTS_LAYOUTS.map(({ id, label, hint, icon: Icon }) => (
              <button key={id} type="button" className={layout === id ? "active" : undefined} aria-pressed={layout === id} aria-label={label} title={hint} onClick={() => choose(id)}>
                <Icon size={14} aria-hidden="true" />
                <span className="fleet-layout-label">{label}</span>
              </button>
            ))}
          </div>
        )}
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

      {runners.length > 0 && (layout === "list" ? <ListLayout {...props} /> : layout === "table" ? <TableLayout {...props} /> : <CardsLayout {...props} />)}

      {runners.length === 0 && sessions.length === 0 && (
        <button type="button" className="fleet-agent-card fleet-agent-add" onClick={() => setAdding(true)}>
          <Plus size={22} strokeWidth={1.5} />
          Add your first runner
          <span className="fleet-muted">A runner is a machine that hosts your agents.</span>
        </button>
      )}

      {openAgent && openRunner && <AgentDetails model={model} agent={openAgent} runner={openRunner} send={send} onOpenChat={onOpenChat} onClose={() => setOpenKey(null)} />}

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
