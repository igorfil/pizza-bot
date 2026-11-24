import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CheckCheck, RotateCcw } from "lucide-react";
import { useAppToast } from "../AppToast.js";
import type { FleetModel, FleetTask } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { InboxCard, RunDialog, RunResult, type OpenChat } from "./RunCard.js";
import { agentName, ago, groupByAgent, groupByDay, runTitle, selectedOrNext, taskAgentKey, taskTone } from "./fleet-view-model.js";

type LayoutProps = { model: FleetModel; tasks: FleetTask[]; send: FleetSend; onOpenChat: OpenChat };

const errorText = (e: unknown) => (e instanceof Error ? e.message : undefined);

/** Several intents at once, with one toast if any of them is refused. */
const useBulk = (send: FleetSend) => {
  const notify = useAppToast();
  const [busy, setBusy] = useState(false);
  const run = async (label: string, intents: [Parameters<FleetSend>[0], Parameters<FleetSend>[1]][]) => {
    setBusy(true);
    try {
      await Promise.all(intents.map(([type, payload]) => send(type, payload)));
      return true;
    } catch (e) {
      notify({ title: `Couldn't ${label}`, description: errorText(e), tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
};

const ackAll = (tasks: FleetTask[]): [Parameters<FleetSend>[0], Parameters<FleetSend>[1]][] =>
  tasks.map((t) => ["AckInbox", { taskId: t.id }]);

function RunLine({ model, task }: { model: FleetModel; task: FleetTask }) {
  return (
    <>
      <span className={`dot dot-${taskTone(task.state) === "bad" ? "bad" : task.state === "completed" ? "ok" : "warn"}`} aria-hidden="true" />
      <span className="fleet-run-line-text">
        <span className="fleet-run-line-title">{runTitle(model, task)}</span>
        <span className="fleet-run-line-sub">
          {agentName(model, task)} · {task.runner} · {ago(model.now, task.updatedAt)}
          {task.trigger === "schedule" && " · scheduled"}
          {taskTone(task.state) === "bad" && ` · ${task.state}`}
        </span>
      </span>
    </>
  );
}

/** Mail-style: the list on the left, the selected result on the right; ↑/↓ or j/k move. */
export function ListLayout({ model, tasks, send, onOpenChat }: LayoutProps) {
  const [selectedId, setSelectedId] = useState<string | null>(tasks[0]?.id ?? null);
  const lastIndex = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const selected = selectedOrNext(tasks, selectedId, lastIndex.current);
  const index = selected ? tasks.indexOf(selected) : -1;
  if (index >= 0) lastIndex.current = index;

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  const move = (by: number) => {
    const next = tasks[Math.min(Math.max(index + by, 0), tasks.length - 1)];
    if (next) setSelectedId(next.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "j") move(1);
    else if (e.key === "ArrowUp" || e.key === "k") move(-1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="fleet-inbox-split">
      <ul ref={list} className="fleet-inbox-list" role="listbox" aria-label="Results" tabIndex={0} onKeyDown={onKeyDown} aria-activedescendant={selected ? `fleet-row-${selected.id}` : undefined}>
        {tasks.map((t) => (
          <li
            key={t.id}
            id={`fleet-row-${t.id}`}
            role="option"
            aria-selected={t.id === selected?.id}
            className={`fleet-inbox-row${t.id === selected?.id ? " active" : ""}`}
            onClick={() => setSelectedId(t.id)}
          >
            <RunLine model={model} task={t} />
          </li>
        ))}
      </ul>
      <div className="fleet-inbox-detail">
        {selected && <InboxCard key={selected.id} model={model} task={selected} send={send} onOpenChat={onOpenChat} variant="detail" />}
      </div>
    </div>
  );
}

/** Every result in full, newest first, under day headings. */
export function FeedLayout({ model, tasks, send, onOpenChat }: LayoutProps) {
  return (
    <div className="fleet-feed">
      {groupByDay(tasks, model.now).map((day) => (
        <section key={day.label} className="fleet-feed-day" aria-label={day.label}>
          <h3 className="fleet-feed-day-title">{day.label}</h3>
          {day.tasks.map((t) => (
            <InboxCard key={t.id} model={model} task={t} send={send} onOpenChat={onOpenChat} variant="compact" />
          ))}
        </section>
      ))}
    </div>
  );
}

/** One section per agent: its newest result open, older ones as rows. */
export function AgentsLayout({ model, tasks, send, onOpenChat }: LayoutProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? model.tasks[openId] : undefined;
  const { busy, run } = useBulk(send);
  return (
    <div className="fleet-agent-groups">
      {groupByAgent(model, tasks).map((group) => {
        const [newest, ...older] = group.tasks;
        return (
          <section key={group.key} className="fleet-agent-group" aria-label={group.name}>
            <header className="fleet-agent-group-head">
              <h3 className="fleet-agent-group-title">{group.name}</h3>
              <span className="fleet-chat-badge">{group.tasks.length}</span>
              <span className="fleet-agent-links-spacer" />
              {group.tasks.length > 1 && (
                <button type="button" className="fleet-link-btn" disabled={busy} onClick={() => void run(`mark ${group.name} read`, ackAll(group.tasks))}>
                  <CheckCheck size={13} /> Mark all read
                </button>
              )}
            </header>
            {newest && <InboxCard model={model} task={newest} send={send} onOpenChat={onOpenChat} variant="compact" />}
            {older.length > 0 && (
              <ul className="fleet-agent-group-older" aria-label={`Older results from ${group.name}`}>
                {older.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="fleet-inbox-row" onClick={() => setOpenId(t.id)}>
                      <RunLine model={model} task={t} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {open && <RunDialog model={model} task={open} send={send} onOpenChat={onOpenChat} onClose={() => setOpenId(null)} />}
    </div>
  );
}

export type ThumbSize = "s" | "m" | "l";

export const THUMB_SIZES: { id: ThumbSize; label: string }[] = [
  { id: "s", label: "Small" },
  { id: "m", label: "Medium" },
  { id: "l", label: "Large" },
];

/** Page thumbnails, like a PDF viewer's: each result scaled down whole, opened in a dialog. */
export function OverviewLayout({ model, tasks, send, onOpenChat, size = "m" }: LayoutProps & { size?: ThumbSize }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? model.tasks[openId] : undefined;
  return (
    <>
      <ul className={`fleet-thumbs fleet-thumbs-${size}`} aria-label="Results overview">
        {tasks.map((t) => {
          const failed = taskTone(t.state) === "bad";
          const unread = t.ackedAt == null;
          return (
            <li key={t.id} className={`fleet-thumb${failed ? " failed" : ""}${unread ? " unread" : ""}`}>
              <div className="fleet-thumb-page" aria-hidden="true" inert>
                <div className="fleet-thumb-content">
                  <p className="fleet-thumb-heading">{runTitle(model, t)}</p>
                  <RunResult task={t} />
                </div>
              </div>
              <div className="fleet-thumb-caption" aria-hidden="true">
                <span className="fleet-thumb-title">
                  {unread && <span className="fleet-thumb-dot" />}
                  {runTitle(model, t)}
                </span>
                <span className="fleet-run-line-sub">
                  {agentName(model, t)} · {ago(model.now, t.updatedAt)}
                  {failed && ` · ${t.state}`}
                </span>
              </div>
              <button
                type="button"
                className="fleet-thumb-open"
                onClick={() => setOpenId(t.id)}
                aria-label={`${runTitle(model, t)}, ${agentName(model, t)}, ${t.state}${unread ? ", unread" : ""}`}
              />
            </li>
          );
        })}
      </ul>
      {open && <RunDialog model={model} task={open} send={send} onOpenChat={onOpenChat} onClose={() => setOpenId(null)} />}
    </>
  );
}

/** One row per result; pick rows to mark read or run again together. */
export function TableLayout({ model, tasks, send, onOpenChat }: LayoutProps) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? model.tasks[openId] : undefined;
  const { busy, run } = useBulk(send);
  const chosen = tasks.filter((t) => picked.has(t.id));
  const all = tasks.length > 0 && chosen.length === tasks.length;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = (label: string, intents: Parameters<typeof run>[1]) =>
    void run(label, intents).then((ok) => ok && setPicked(new Set()));

  return (
    <div className="fleet-table-wrap">
      <div className="fleet-table-bulk" role="toolbar" aria-label="Selected results">
        <span className="fleet-muted">{chosen.length > 0 ? `${chosen.length} selected` : "Select results to act on several at once"}</span>
        <span className="fleet-agent-links-spacer" />
        <button type="button" className="btn-secondary fleet-small-btn" disabled={busy || chosen.length === 0} onClick={() => bulk("run them again", chosen.map((t) => ["CreateTask", { agent: taskAgentKey(t), prompt: t.prompt }]))}>
          <RotateCcw size={13} /> Run again
        </button>
        <button type="button" className="btn-primary fleet-small-btn" disabled={busy || chosen.length === 0} onClick={() => bulk("mark them read", ackAll(chosen))}>
          <CheckCheck size={13} /> Mark read
        </button>
      </div>
      <table className="fleet-inbox-table">
        <thead>
          <tr>
            <th className="fleet-table-check">
              <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(tasks.map((t) => t.id)))} aria-label="Select all results" />
            </th>
            <th>Agent</th>
            <th>Input</th>
            <th>State</th>
            <th>Runner</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className={picked.has(t.id) ? "picked" : undefined} onClick={() => setOpenId(t.id)}>
              <td className="fleet-table-check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${runTitle(model, t)}`} />
              </td>
              <td>
                <button type="button" className="fleet-table-open" onClick={() => setOpenId(t.id)}>
                  {agentName(model, t)}
                </button>
              </td>
              <td className="fleet-table-input">{t.prompt || <span className="fleet-muted">(no input)</span>}</td>
              <td>
                <span className={`fleet-state fleet-tone-${taskTone(t.state)}`}>{t.state}</span>
              </td>
              <td className="fleet-muted">{t.runner}</td>
              <td className="fleet-muted">{ago(model.now, t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <RunDialog model={model} task={open} send={send} onOpenChat={onOpenChat} onClose={() => setOpenId(null)} />}
    </div>
  );
}
