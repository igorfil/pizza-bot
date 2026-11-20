import { useState } from "react";
import { Network, PlugZap } from "lucide-react";
import { ModuleHeader } from "../ModuleHeader.js";
import { ModuleTabs } from "../ModuleTabs.js";
import { L } from "../../lexicon.js";
import { DEFAULT_FLEET_URL, type FleetConnection, type FleetIntent } from "./fleet-client.js";
import type { FleetModel } from "./fleet-types.js";
import type { FleetLink } from "./use-fleet.js";
import { inboxOf, runningCount } from "./fleet-view-model.js";
import { InboxView } from "./InboxView.js";
import { ChatsView } from "./ChatsView.js";
import { AgentsView } from "./AgentsView.js";

export type FleetSend = (type: FleetIntent, payload: Record<string, string>) => Promise<string | null>;

export type FleetTab = "inbox" | "chats" | "agents";

export function FleetLinkBadge({ link }: { link: FleetLink }) {
  const [tone, text] =
    link.kind === "live"
      ? ["ok", "Live"]
      : link.kind === "connecting"
        ? ["info", "Connecting…"]
        : link.kind === "retrying"
          ? ["warn", "Reconnecting…"]
          : ["bad", "Not connected"];
  return (
    <span className="fleet-link" title={"error" in link ? link.error : undefined} role="status">
      <span className={`dot dot-${tone}`} aria-hidden="true" /> {text}
    </span>
  );
}

export interface FleetModuleProps {
  model: FleetModel | null;
  link: FleetLink;
  send: FleetSend;
  onEditConnection: () => void;
  initialTab?: FleetTab;
}

export function FleetModule({ model, link, send, onEditConnection, initialTab = "inbox" }: FleetModuleProps) {
  const [tab, setTab] = useState<FleetTab>(initialTab);
  const [chatId, setChatId] = useState<string | null>(null);
  const unread = model ? inboxOf(model).length : 0;
  const running = model ? runningCount(model) : 0;

  const openChat = (id: string) => {
    setChatId(id);
    setTab("chats");
  };

  return (
    <section className="module fleet-module">
      <ModuleHeader icon={<Network size={18} />} title={L.fleetSection}>
        <span className="module-header-spacer" />
        {running > 0 && <span className="fleet-running">{running} running</span>}
        {link.kind === "retrying" && <span className="fleet-link-error">{link.error}</span>}
        <FleetLinkBadge link={link} />
        <button type="button" className="btn-secondary" onClick={onEditConnection}>
          <PlugZap size={15} /> Connection
        </button>
      </ModuleHeader>
      <ModuleTabs<FleetTab>
        ariaLabel="Fleet views"
        active={tab}
        onSelect={setTab}
        tabs={[
          { key: "inbox", label: unread > 0 ? `Inbox (${unread})` : "Inbox" },
          { key: "chats", label: "Chats" },
          { key: "agents", label: "Agents" },
        ]}
      />
      <div className="fleet-body" role="tabpanel">
        {!model ? (
          <div className="fleet-empty fleet-waiting">Waiting for the Controller to send the fleet…</div>
        ) : tab === "inbox" ? (
          <InboxView model={model} send={send} onOpenChat={openChat} />
        ) : tab === "chats" ? (
          <ChatsView model={model} send={send} selectedId={chatId} onSelect={setChatId} />
        ) : (
          <AgentsView model={model} send={send} />
        )}
      </div>
    </section>
  );
}

export function FleetConnectForm({
  initial,
  error,
  onConnect,
  onCancel,
}: {
  initial: FleetConnection | null;
  error?: string;
  onConnect: (connection: FleetConnection) => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? DEFAULT_FLEET_URL);
  const [token, setToken] = useState(initial?.token ?? "");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const canConnect = /^https?:\/\/.+/.test(url.trim()) && token.trim() !== "";

  return (
    <section className="module fleet-module">
      <ModuleHeader icon={<Network size={18} />} title={L.fleetSection} />
      <form
        className="resource-editor fleet-connect"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConnect) onConnect({ url: url.trim(), token: token.trim() });
        }}
      >
        <header className="resource-editor-head">
          <h2 className="resource-editor-title">Connect to a fleet Controller</h2>
          <p className="field-hint">
            The Controller runs on your machine and tracks agents on local and remote runners. This screen is a view
            of it: runs keep going when the app is closed.
          </p>
        </header>
        <div className="resource-editor-body">
          <label className="field">
            <span className="field-label">Controller URL</span>
            <input className="field-input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">API token</span>
            <input
              className="field-input mono"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <span className="field-hint">
              Copy it with <code>cat ~/.agent-fleet/token</code>.
            </span>
          </label>
          <p className="field-hint">
            Start the Controller with <code>FLEET_ALLOWED_ORIGINS={origin || "<this app's origin>"}</code> so it accepts
            requests from this app.
          </p>
          {error && <div className="schedule-editor-error" role="alert">{error}</div>}
        </div>
        <footer className="resource-editor-actions">
          <span className="resource-editor-actions-spacer" />
          {onCancel && (
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn-primary" disabled={!canConnect}>
            Connect
          </button>
        </footer>
      </form>
    </section>
  );
}
