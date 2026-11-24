import { useState, type FormEvent } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { mcpServerSummary } from "./AddAgentDialog.js";
import type { FleetAgent, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { FleetDialog } from "./GuideCard.js";

const ID = /^[a-z0-9_-]+$/;

const ENTRY_EXAMPLE = '{ "command": "uvx", "args": ["mcp-server-fetch"] }';

type Parsed = { servers: [string, unknown][] } | { error: string };

/**
 * Takes one server's entry under the given id, or a whole `.mcp.json` (`{"mcpServers": {...}}`) as
 * MCP servers document it, which adds every server in it.
 */
export const parseServers = (id: string, text: string): Parsed => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "The server must be a JSON object." };
  const wrapped = (value as { mcpServers?: unknown }).mcpServers;
  const servers: [string, unknown][] =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped) ? Object.entries(wrapped) : [[id.trim(), value]];
  const badId = servers.find(([sid]) => !ID.test(sid));
  if (badId) return { error: badId[0] ? `"${badId[0]}" can't be a server id: use lowercase letters, digits, - or _.` : "Give the server an id." };
  return { servers };
};

/** The agents on this runner that use the server, so removing it says what breaks. */
const usersOf = (agents: FleetAgent[], id: string): string[] => agents.filter((a) => a.mcp?.includes(id)).map((a) => a.name);

export function McpServersDialog({ runner, agents, send, onClose }: { runner: FleetRunner; agents: FleetAgent[]; send: FleetSend; onClose: () => void }) {
  const servers = Object.entries(runner.mcpServers ?? {});
  const [id, setId] = useState("");
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = entry.trim() ? parseServers(id, entry) : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed || "error" in parsed) return;
    setSaving(true);
    setError(null);
    try {
      for (const [sid, e] of parsed.servers) {
        await send("SetMcpServer", { runner: runner.name, id: sid, entry: JSON.stringify(e) });
      }
      setId("");
      setEntry("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The Controller didn't take that.");
    } finally {
      setSaving(false);
    }
  };

  const edit = (sid: string, e: Record<string, unknown>) => {
    setId(sid);
    setEntry(JSON.stringify(e, null, 2));
  };

  const remove = (sid: string) => {
    setError(null);
    send("RemoveMcpServer", { runner: runner.name, id: sid }).catch((e: unknown) => setError(e instanceof Error ? e.message : "The Controller didn't take that."));
  };

  return (
    <FleetDialog title={`MCP servers on ${runner.name}`} onClose={onClose}>
      <p className="field-hint">
        These run on {runner.name}&apos;s machine. Agents on {runner.name} pick the ones they use. Write tokens as <code>{"${VAR}"}</code> and set them in the
        runner&apos;s environment.
      </p>
      {servers.length === 0 ? (
        <p className="fleet-muted">No MCP servers yet.</p>
      ) : (
        <ul className="fleet-mcp-list" aria-label={`MCP servers on ${runner.name}`}>
          {servers.map(([sid, e]) => {
            const users = usersOf(agents, sid);
            return (
              <li key={sid} className="fleet-mcp-row">
                <button type="button" className="fleet-mcp-name" onClick={() => edit(sid, e)} title="Edit">
                  {sid}
                </button>
                <code className="fleet-mcp-cmd">{mcpServerSummary(e)}</code>
                <span className="fleet-muted">{users.length > 0 ? `used by ${users.join(", ")}` : "not used yet"}</span>
                <button
                  type="button"
                  className="fleet-icon-btn fleet-link-danger"
                  onClick={() => remove(sid)}
                  aria-label={`Remove MCP server ${sid}`}
                  title={users.length > 0 ? `Remove; ${users.join(", ")} will run without it` : "Remove"}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="fleet-guide" onSubmit={(e) => void save(e)}>
        <label className="field">
          <span className="field-label">Server id</span>
          <input className="field-input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="fetch" spellCheck={false} />
        </label>
        <label className="field">
          <span className="field-label">Server</span>
          <textarea
            className="field-input fleet-prompt fleet-code"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={ENTRY_EXAMPLE}
            aria-invalid={parsed !== null && "error" in parsed}
          />
          {parsed && "error" in parsed ? (
            <span className="schedule-editor-error" role="alert">
              {parsed.error}
            </span>
          ) : (
            <span className="field-hint">
              The server&apos;s entry: a <code>command</code> with <code>args</code>, or a <code>url</code>. Pasting a whole <code>.mcp.json</code> adds every
              server in it.
            </span>
          )}
        </label>
        {error && (
          <div className="schedule-editor-error" role="alert">
            {error}
          </div>
        )}
        <div className="fleet-guide-actions">
          <span className="fleet-agent-links-spacer" />
          <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose} disabled={saving}>
            Done
          </button>
          <button type="submit" className="btn-primary fleet-small-btn" disabled={saving || !parsed || "error" in parsed}>
            {saving && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
            {id in (runner.mcpServers ?? {}) ? "Save server" : "Add server"}
          </button>
        </div>
      </form>
    </FleetDialog>
  );
}
