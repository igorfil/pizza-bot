import { useState } from "react";
import { CheckCheck, Columns2, Inbox, Layers, LayoutGrid, Newspaper, Table2, Users, type LucideIcon } from "lucide-react";
import { useAppToast } from "../AppToast.js";
import type { FleetModel } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { AgentsLayout, FeedLayout, ListLayout, OverviewLayout, TableLayout, THUMB_SIZES, type ThumbSize } from "./InboxLayouts.js";
import { InboxCard, type OpenChat } from "./RunCard.js";
import { finishedRunsOf, inboxOf } from "./fleet-view-model.js";

const STACK_DEPTH = 2;

export type InboxLayout = "overview" | "stack" | "list" | "feed" | "agents" | "table";

export const INBOX_LAYOUTS: { id: InboxLayout; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", hint: "Every result as a page thumbnail", icon: LayoutGrid },
  { id: "stack", label: "Stack", hint: "One result at a time", icon: Layers },
  { id: "list", label: "List", hint: "List and the selected result side by side; ↑/↓ or j/k to move", icon: Columns2 },
  { id: "feed", label: "Feed", hint: "Every result in full, by day", icon: Newspaper },
  { id: "agents", label: "By agent", hint: "Grouped by agent, newest open", icon: Users },
  { id: "table", label: "Table", hint: "One row per result; act on several at once", icon: Table2 },
];

const LAYOUT_KEY = "pizza.fleet.inboxLayout";
const THUMB_KEY = "pizza.fleet.thumbSize";

/** Layouts that can also show results already marked read. */
const SHOWS_READ: ReadonlySet<InboxLayout> = new Set(["overview", "feed"]);

const loadThumbSize = (): ThumbSize => {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(THUMB_KEY);
  return THUMB_SIZES.find((s) => s.id === saved)?.id ?? "m";
};

export const loadInboxLayout = (): InboxLayout => {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(LAYOUT_KEY);
  return INBOX_LAYOUTS.find((l) => l.id === saved)?.id ?? "stack";
};

export const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be full or disabled; the choice then lasts until reload.
  }
};

function LayoutSwitcher({ value, onChange }: { value: InboxLayout; onChange: (layout: InboxLayout) => void }) {
  return (
    <div className="fleet-segmented fleet-layout-switcher" role="group" aria-label="Inbox layout">
      {INBOX_LAYOUTS.map(({ id, label, hint, icon: Icon }) => (
        <button key={id} type="button" className={value === id ? "active" : undefined} aria-pressed={value === id} aria-label={label} title={hint} onClick={() => onChange(id)}>
          <Icon size={14} aria-hidden="true" />
          <span className="fleet-layout-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function InboxView({
  model,
  send,
  onOpenChat,
  initialLayout,
}: {
  model: FleetModel;
  send: FleetSend;
  onOpenChat: OpenChat;
  initialLayout?: InboxLayout;
}) {
  const notify = useAppToast();
  const [layout, setLayout] = useState<InboxLayout>(() => initialLayout ?? loadInboxLayout());
  const [showRead, setShowRead] = useState(false);
  const [thumbSize, setThumbSize] = useState<ThumbSize>(loadThumbSize);
  const unread = inboxOf(model);
  const tasks = SHOWS_READ.has(layout) && showRead ? finishedRunsOf(model) : unread;

  const choose = (next: InboxLayout) => {
    setLayout(next);
    save(LAYOUT_KEY, next);
  };

  const resize = (next: ThumbSize) => {
    setThumbSize(next);
    save(THUMB_KEY, next);
  };

  const ackAll = async () => {
    try {
      await send("AckAllInbox", {});
    } catch (e) {
      notify({ title: "Couldn't clear the inbox", description: e instanceof Error ? e.message : undefined, tone: "error" });
    }
  };

  const props = { model, tasks, send, onOpenChat };
  const top = tasks[0];

  return (
    <div className={`fleet-inbox fleet-inbox--${layout}`}>
      <div className="fleet-inbox-bar">
        <span className="fleet-muted fleet-inbox-count">
          {unread.length === 0 ? "No results to review" : unread.length === 1 ? "1 result to review" : `${unread.length} results to review`}
        </span>
        <LayoutSwitcher value={layout} onChange={choose} />
        <span className="fleet-inbox-bar-actions">
          {unread.length > 1 && (
            <button type="button" className="btn-secondary fleet-small-btn" onClick={() => void ackAll()}>
              <CheckCheck size={14} /> Mark all read
            </button>
          )}
        </span>
      </div>
      {SHOWS_READ.has(layout) && (
        <div className="fleet-inbox-options">
          {layout === "overview" && (
            <span className="fleet-segmented fleet-thumb-sizes" role="group" aria-label="Thumbnail size">
              {THUMB_SIZES.map((s) => (
                <button key={s.id} type="button" className={thumbSize === s.id ? "active" : undefined} aria-pressed={thumbSize === s.id} aria-label={`${s.label} thumbnails`} title={`${s.label} thumbnails`} onClick={() => resize(s.id)}>
                  <LayoutGrid size={s.id === "s" ? 11 : s.id === "m" ? 13 : 15} aria-hidden="true" />
                </button>
              ))}
            </span>
          )}
          <label className="fleet-inbox-show-read">
            <input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} /> Show read
          </label>
        </div>
      )}

      {!top ? (
        <div className="fleet-inbox-empty">
          <Inbox size={40} strokeWidth={1} />
          <p className="fleet-inbox-empty-title">All caught up</p>
          <p className="fleet-muted">When an agent finishes a run, its result shows up here.</p>
        </div>
      ) : layout === "overview" ? (
        <OverviewLayout {...props} size={thumbSize} />
      ) : layout === "list" ? (
        <ListLayout {...props} />
      ) : layout === "feed" ? (
        <FeedLayout {...props} />
      ) : layout === "agents" ? (
        <AgentsLayout {...props} />
      ) : layout === "table" ? (
        <TableLayout {...props} />
      ) : (
        <div className="fleet-stack" style={{ ["--fleet-stack-depth" as string]: Math.min(tasks.length - 1, STACK_DEPTH) }}>
          {tasks.slice(1, 1 + STACK_DEPTH).map((t, i) => (
            <div key={t.id} className="fleet-stack-shadow" style={{ ["--fleet-stack-i" as string]: i + 1 }} aria-hidden="true" />
          ))}
          <InboxCard key={top.id} model={model} task={top} send={send} onOpenChat={onOpenChat} />
        </div>
      )}
    </div>
  );
}
