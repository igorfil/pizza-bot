import { useState, type FormEvent } from "react";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { FleetAgent, FleetModel, FleetRunner } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { ChoiceCard, FleetDialog } from "./GuideCard.js";

const message = (e: unknown) => (e instanceof Error ? e.message : "The Controller didn't take that.");

type Mode = "create" | "existing";

/** What the runner can do for Add agent right now: a reason it can't, or the modes it offers. */
export const addAgentModes = (runner: FleetRunner): { blocker: string } | { modes: Mode[] } => {
  if (runner.status !== "healthy") return { blocker: `${runner.name} isn't reachable right now. Try again once it's online.` };
  const modes: Mode[] = [...(runner.canCreateAgents ? ["create" as const] : []), ...((runner.available?.length ?? 0) > 0 ? ["existing" as const] : [])];
  if (modes.length > 0) return { modes };
  return {
    blocker:
      runner.available == null
        ? `${runner.name} can't change its agents from here. Update the runner to a version that supports adding agents.`
        : `Every agent on ${runner.name} is already added.`,
  };
};

function Actions({ saving, disabled, label, onClose }: { saving: boolean; disabled: boolean; label: string; onClose: () => void }) {
  return (
    <div className="fleet-guide-actions">
      <span className="fleet-agent-links-spacer" />
      <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button type="submit" className="btn-primary fleet-small-btn" disabled={saving || disabled}>
        {saving && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
        {label}
      </button>
    </div>
  );
}

/** Sends one intent, closing the dialog on success and keeping the form with the reason on failure. */
const useSubmit = (onClose: () => void) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent, f: () => Promise<unknown>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await f();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, submit };
};

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <div className="schedule-editor-error" role="alert">
      {error}
    </div>
  ) : null;
}

/** `mcpServers` is `.mcp.json` text and each skill a whole SKILL.md; the Controller parses both. */
type AgentSpec = { name: string; model: string; systemPrompt: string; mcpServers: string; skills: string[] };

/** MCP servers and skills need the runner's pizza-bot harness. */
export const runsTools = (runner: FleetRunner | undefined): boolean => runner?.harnesses?.includes("pizza-bot") ?? false;

const MCP_EXAMPLE = '{\n  "mcpServers": {\n    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }\n  }\n}';

const SKILL_TEMPLATE = "---\nname: my-skill\ndescription: What this skill does, and when to use it.\ntools:\n  - mcp:fetch:*\n---\nHow to do the work, step by step, and what to report back.\n";

/** Null when the text is empty or valid JSON. */
const jsonProblem = (text: string): string | null => {
  if (text.trim() === "") return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "not valid JSON";
  }
};

const skillName = (content: string): string | null => /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)/m.exec(content)?.[1]?.trim() ?? null;

export const mcpServersText = (agent: FleetAgent): string =>
  agent.mcpServers && Object.keys(agent.mcpServers).length > 0 ? JSON.stringify({ mcpServers: agent.mcpServers }, null, 2) : "";

function ToolsFields({
  mcpServers,
  setMcpServers,
  skills,
  setSkills,
}: {
  mcpServers: string;
  setMcpServers: (text: string) => void;
  skills: string[];
  setSkills: (skills: string[]) => void;
}) {
  const problem = jsonProblem(mcpServers);
  return (
    <>
      <label className="field">
        <span className="field-label">MCP servers</span>
        <textarea
          className="field-input fleet-prompt fleet-code"
          value={mcpServers}
          onChange={(e) => setMcpServers(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={MCP_EXAMPLE}
          aria-invalid={problem !== null}
        />
        {problem ? (
          <span className="schedule-editor-error" role="alert">
            Not valid JSON: {problem}
          </span>
        ) : (
          <span className="field-hint">
            The <code>.mcp.json</code> an MCP server documents. Commands run on the runner&apos;s machine; write tokens as <code>{"${VAR}"}</code> and set them in
            the runner&apos;s environment.
          </span>
        )}
      </label>
      <fieldset className="fleet-choice-field">
        <legend className="field-label fleet-choice-legend">Skills</legend>
        <div className="fleet-skill-list">
          {skills.map((content, i) => (
            <div key={i} className="fleet-skill">
              <div className="fleet-skill-head">
                <span>{skillName(content) ?? `Skill ${i + 1}`}</span>
                <button
                  type="button"
                  className="fleet-icon-btn fleet-link-danger"
                  onClick={() => setSkills(skills.filter((_, j) => j !== i))}
                  aria-label={`Remove ${skillName(content) ?? `skill ${i + 1}`}`}
                  title="Remove skill"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                className="field-input fleet-prompt fleet-code"
                value={content}
                onChange={(e) => setSkills(skills.map((s, j) => (j === i ? e.target.value : s)))}
                rows={8}
                spellCheck={false}
                aria-label={`SKILL.md of ${skillName(content) ?? `skill ${i + 1}`}`}
              />
            </div>
          ))}
          <button type="button" className="btn-secondary fleet-small-btn fleet-skill-add" onClick={() => setSkills([...skills, SKILL_TEMPLATE])}>
            <Plus size={13} aria-hidden="true" />
            Add skill
          </button>
        </div>
        <span className="field-hint">
          Each skill is a SKILL.md. Its <code>tools</code> list grants MCP tools, like <code>mcp:fetch:*</code>. A server no skill grants gets a skill of its own.
        </span>
      </fieldset>
    </>
  );
}

/** A created agent: a name, a model and a system prompt, plus MCP servers and skills on a pizza-bot runner. */
function AgentSpecForm({
  model,
  tools,
  initial,
  label,
  onSave,
  onClose,
}: {
  model: FleetModel;
  tools: boolean;
  initial?: AgentSpec;
  label: string;
  onSave: (spec: Partial<AgentSpec>) => Promise<unknown>;
  onClose: () => void;
}) {
  const models = model.agentModels ?? [];
  const [name, setName] = useState(initial?.name ?? "");
  const [picked, setPicked] = useState(models.find((m) => m.id === initial?.model)?.id ?? models[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [mcpServers, setMcpServers] = useState(initial?.mcpServers ?? "");
  const [skills, setSkills] = useState<string[]>(initial?.skills ?? []);
  const { saving, error, submit } = useSubmit(onClose);
  const spec = (): Partial<AgentSpec> => ({ name: name.trim(), model: picked, systemPrompt, ...(tools ? { mcpServers, skills } : {}) });
  return (
    <form className="fleet-guide" onSubmit={(e) => void submit(e, () => onSave(spec()))}>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Release notes writer" autoFocus />
      </label>
      <fieldset className="fleet-choice-field">
        <legend className="field-label fleet-choice-legend">Model</legend>
        <div className="fleet-choice-grid">
          {models.map((m) => (
            <ChoiceCard key={m.id} type="radio" name="model" value={m.id} checked={picked === m.id} title={m.label} detail={m.id} onChange={() => setPicked(m.id)} />
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">System prompt</span>
        <textarea
          className="field-input fleet-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder="You turn a list of merged pull requests into short, friendly release notes."
        />
        <span className="field-hint">
          {tools
            ? "Each run gives the agent the message you type, with this prompt and the tools and skills below, and returns its answer."
            : "Each run sends the message you type to the model with this prompt and returns its reply."}
        </span>
      </label>
      {tools && <ToolsFields mcpServers={mcpServers} setMcpServers={setMcpServers} skills={skills} setSkills={setSkills} />}
      <ErrorLine error={error} />
      <Actions saving={saving} disabled={name.trim() === "" || picked === "" || (tools && jsonProblem(mcpServers) !== null)} label={label} onClose={onClose} />
    </form>
  );
}

export function EditAgentDialog({ model, agent, send, onClose }: { model: FleetModel; agent: FleetAgent; send: FleetSend; onClose: () => void }) {
  return (
    <FleetDialog title={`Edit ${agent.name}`} onClose={onClose}>
      <AgentSpecForm
        model={model}
        tools={runsTools(model.runners[agent.runner])}
        initial={{
          name: agent.name,
          model: agent.model ?? "",
          systemPrompt: agent.systemPrompt ?? "",
          mcpServers: mcpServersText(agent),
          skills: (agent.skills ?? []).map((s) => s.content),
        }}
        label="Save changes"
        onSave={(spec) => send("EditAgent", { agent: agent.key, ...spec })}
        onClose={onClose}
      />
    </FleetDialog>
  );
}

/** Picks agents from what the runner has on disk but doesn't serve yet. */
function ExistingAgentsForm({ runner, send, onClose }: { runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const { saving, error, submit } = useSubmit(onClose);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <form className="fleet-guide" onSubmit={(e) => void submit(e, () => send("AddAgents", { runner: runner.name, agents: [...picked] }))}>
      <p className="field-hint">Pick what {runner.name} should also run. They're already on the machine, so nothing is installed.</p>
      <fieldset className="fleet-choice-field">
        <legend className="field-label fleet-choice-legend">Agents</legend>
        <div className="fleet-choice-grid">
          {(runner.available ?? []).map((a) => (
            <ChoiceCard
              key={a.id}
              type="checkbox"
              name="agents"
              value={a.id}
              checked={picked.has(a.id)}
              title={a.name}
              {...(a.description ? { detail: a.description } : {})}
              onChange={() => toggle(a.id)}
            />
          ))}
        </div>
      </fieldset>
      <ErrorLine error={error} />
      <Actions saving={saving} disabled={picked.size === 0} label={picked.size > 1 ? `Add ${picked.size} agents` : "Add agent"} onClose={onClose} />
    </form>
  );
}

const MODE_LABELS: Record<Mode, string> = { create: "Create new", existing: "Turn on existing" };

export function AddAgentDialog({ model, runner, send, onClose }: { model: FleetModel; runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const offer = addAgentModes(runner);
  const [mode, setMode] = useState<Mode>("modes" in offer ? offer.modes[0]! : "create");
  return (
    <FleetDialog title={`Add agent to ${runner.name}`} onClose={onClose}>
      {"blocker" in offer ? (
        <>
          <p className="sidebar-modal-body">{offer.blocker}</p>
          <div className="fleet-guide-actions">
            <span className="fleet-agent-links-spacer" />
            <button type="button" className="btn-secondary fleet-small-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          {offer.modes.length > 1 && (
            <div className="fleet-segmented" role="tablist" aria-label="How to add the agent">
              {offer.modes.map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "active" : undefined} onClick={() => setMode(m)}>
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}
          {mode === "create" ? (
            <AgentSpecForm
              model={model}
              tools={runsTools(runner)}
              label="Create agent"
              onSave={(spec) => send("CreateAgent", { runner: runner.name, ...spec })}
              onClose={onClose}
            />
          ) : (
            <ExistingAgentsForm runner={runner} send={send} onClose={onClose} />
          )}
        </>
      )}
    </FleetDialog>
  );
}
