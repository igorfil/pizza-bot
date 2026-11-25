import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { FleetAgent, FleetModel, FleetPlugin, FleetRunner } from "./fleet-types.js";
import type { FleetPayload } from "./fleet-client.js";
import { useSkillLibrary, type FleetSkillLibrary, type LibrarySkill, type SkillsState } from "./fleet-skills.js";
import type { FleetSend } from "./FleetModule.js";
import { ChoiceCard, FleetDialog } from "./GuideCard.js";
import { runnerLabel } from "./fleet-view-model.js";

const message = (e: unknown) => (e instanceof Error ? e.message : "The Controller didn't take that.");

type Mode = "create" | "existing";

/** Plugins that can add agents, usable or not; the dialog shows why an unusable one is greyed out. */
export const addablePlugins = (runner: FleetRunner): FleetPlugin[] => (runner.plugins ?? []).filter((p) => p.capabilities.includes("add") && (p.addFields?.length ?? 0) > 0);

/** What the runner can do for Add agent right now: a reason it can't, or the modes it offers. */
export const addAgentModes = (runner: FleetRunner): { blocker: string } | { modes: Mode[] } => {
  if (runner.status !== "healthy") return { blocker: `${runnerLabel(runner)} isn't reachable right now. Try again once it's online.` };
  const modes: Mode[] = [...(runner.canCreateAgents ? ["create" as const] : []), ...(addablePlugins(runner).length > 0 ? ["existing" as const] : [])];
  if (modes.length > 0) return { modes };
  return { blocker: `${runnerLabel(runner)} has no built-in engine and no plugin that can add agents. Reinstall it with the engine.` };
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

type AgentSpec = { name: string; model: string; systemPrompt: string; mcp: string[]; skills: string[] };

/** MCP servers and skills need the runner's pizza-bot harness. */
export const runsTools = (runner: FleetRunner | undefined): boolean => runner?.harnesses?.includes("pizza-bot") ?? false;

/** One line saying what starts the server: its command and arguments, or its URL. */
export const mcpServerSummary = (entry: Record<string, unknown>): string =>
  typeof entry.url === "string"
    ? entry.url
    : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((p): p is string => typeof p === "string").join(" ");

const toggled = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

function McpPicker({ runner, picked, onToggle }: { runner: FleetRunner; picked: readonly string[]; onToggle: (id: string) => void }) {
  const servers = Object.entries(runner.mcpServers ?? {});
  const gone = picked.filter((id) => !(id in (runner.mcpServers ?? {})));
  return (
    <fieldset className="fleet-choice-field">
      <legend className="field-label fleet-choice-legend">MCP servers on {runnerLabel(runner)}</legend>
      {servers.length === 0 ? (
        <p className="field-hint">{runnerLabel(runner)} has no MCP servers yet. Add them with MCP servers on the runner, then pick them here.</p>
      ) : (
        <div className="fleet-choice-grid">
          {servers.map(([id, entry]) => (
            <ChoiceCard key={id} type="checkbox" name="mcp" value={id} checked={picked.includes(id)} title={id} detail={mcpServerSummary(entry)} onChange={() => onToggle(id)} />
          ))}
        </div>
      )}
      {gone.length > 0 && (
        <p className="schedule-editor-error" role="alert">
          {gone.join(", ")} {gone.length === 1 ? "is" : "are"} no longer on {runnerLabel(runner)}. Saving drops {gone.length === 1 ? "it" : "them"}.
        </p>
      )}
    </fieldset>
  );
}

/** Skills come from Pizza Bot's library; the agent keeps a copy, made when the skill is first picked. */
function SkillPicker({
  state,
  attached,
  picked,
  mcp,
  onToggle,
}: {
  state: SkillsState;
  attached: FleetAgent["skills"];
  picked: readonly string[];
  mcp: readonly string[];
  onToggle: (id: string) => void;
}) {
  const library = state.kind === "ready" ? state.skills : [];
  const onlyOnAgent = (attached ?? []).filter((s) => !library.some((l) => l.id === s.id));
  const missing = (s: LibrarySkill) => s.mcpServers.filter((id) => !mcp.includes(id));
  return (
    <fieldset className="fleet-choice-field">
      <legend className="field-label fleet-choice-legend">Skills</legend>
      {state.kind === "loading" && <p className="field-hint">Loading Pizza Bot&apos;s skills…</p>}
      {state.kind === "failed" && <p className="schedule-editor-error">Couldn&apos;t load Pizza Bot&apos;s skills: {state.error}</p>}
      {state.kind === "none" && <p className="field-hint">Skills come from Pizza Bot, which this page can&apos;t reach.</p>}
      <div className="fleet-choice-grid fleet-skill-grid">
        {library.map((s) => (
          <ChoiceCard
            key={s.id}
            type="checkbox"
            name="skills"
            value={s.id}
            checked={picked.includes(s.id)}
            title={s.name}
            detail={picked.includes(s.id) && missing(s).length > 0 ? `Needs MCP server ${missing(s).join(", ")}, which this agent doesn't use. ${s.description}` : s.description}
            onChange={() => onToggle(s.id)}
          />
        ))}
        {onlyOnAgent.map((s) => (
          <ChoiceCard
            key={s.id}
            type="checkbox"
            name="skills"
            value={s.id}
            checked={picked.includes(s.id)}
            title={s.name}
            detail={`Only on this agent now; no longer in Pizza Bot. ${s.description}`}
            onChange={() => onToggle(s.id)}
          />
        ))}
      </div>
      {state.kind === "ready" && library.length === 0 && onlyOnAgent.length === 0 && (
        <p className="field-hint">Pizza Bot has no skills yet. Add them on its Skills page.</p>
      )}
      <span className="field-hint">
        The agent gets its own copy of each skill you pick. Later changes in Pizza Bot don&apos;t reach it; to take them, clear the skill and pick it again before
        saving.
      </span>
    </fieldset>
  );
}

/** Skills the agent already has stay as they are; ones picked in this dialog are copied from the library now. */
const skillPayload = async (
  library: FleetSkillLibrary | null,
  picked: readonly string[],
  attached: FleetAgent["skills"],
  touched: ReadonlySet<string>,
): Promise<FleetPayload[]> =>
  Promise.all(
    picked.map(async (id): Promise<FleetPayload> => {
      if (!touched.has(id) && (attached ?? []).some((s) => s.id === id)) return { id };
      if (!library) throw new Error("Pizza Bot's skills can't be reached from here");
      return { id, files: await library.files(id) };
    }),
  );

/** A created agent: a name, a model and a system prompt, plus MCP servers and skills on a pizza-bot runner. */
function AgentSpecForm({
  model,
  runner,
  initial,
  attachedSkills,
  label,
  onSave,
  onClose,
}: {
  model: FleetModel;
  runner: FleetRunner | undefined;
  initial?: AgentSpec;
  attachedSkills?: FleetAgent["skills"];
  label: string;
  onSave: (spec: FleetPayload) => Promise<unknown>;
  onClose: () => void;
}) {
  const tools = runsTools(runner);
  const models = model.agentModels ?? [];
  const [name, setName] = useState(initial?.name ?? "");
  const [picked, setPicked] = useState(models.find((m) => m.id === initial?.model)?.id ?? models[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [mcp, setMcp] = useState<string[]>(initial?.mcp ?? []);
  const [skills, setSkills] = useState<string[]>(initial?.skills ?? []);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const { library, state } = useSkillLibrary();
  const { saving, error, submit } = useSubmit(onClose);
  const save = async () => {
    const base = { name: name.trim(), model: picked, systemPrompt };
    if (!tools || !runner) return onSave(base);
    const known = mcp.filter((id) => id in (runner.mcpServers ?? {}));
    return onSave({ ...base, mcp: known, skills: await skillPayload(library, skills, attachedSkills, touched) });
  };
  return (
    <form className="fleet-guide" onSubmit={(e) => void submit(e, save)}>
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
      {tools && runner && (
        <>
          <McpPicker runner={runner} picked={mcp} onToggle={(id) => setMcp((prev) => toggled(prev, id))} />
          <SkillPicker state={state} attached={attachedSkills} picked={skills} mcp={mcp} onToggle={(id) => {
              setSkills((prev) => toggled(prev, id));
              setTouched((prev) => new Set([...prev, id]));
            }}
          />
        </>
      )}
      <ErrorLine error={error} />
      <Actions saving={saving} disabled={name.trim() === "" || picked === ""} label={label} onClose={onClose} />
    </form>
  );
}

export function EditAgentForm({ model, agent, send, onClose }: { model: FleetModel; agent: FleetAgent; send: FleetSend; onClose: () => void }) {
  return (
    <AgentSpecForm
      model={model}
      runner={model.runners[agent.runner]}
      initial={{
        name: agent.name,
        model: agent.model ?? "",
        systemPrompt: agent.systemPrompt ?? "",
        mcp: agent.mcp ?? [],
        skills: (agent.skills ?? []).map((s) => s.id),
      }}
      attachedSkills={agent.skills ?? []}
      label="Save changes"
      onSave={(spec) => send("EditAgent", { agent: agent.key, ...spec })}
      onClose={onClose}
    />
  );
}

const MODE_LABELS: Record<Mode, string> = { create: "Create new", existing: "Add existing" };

const MODE_HINTS: Record<Mode, string> = {
  create: "A new agent on the built-in Pizza Bot engine: a model, a system prompt, and the runner's MCP servers and skills.",
  existing: "An agent that already exists (a folder, an image, a deployed runtime), run by one of the runner's plugins with its own tools.",
};

/** An agent that already exists somewhere (a folder, an image, a runtime), added through the plugin that runs that kind. */
function ExistingAgentForm({ runner, send, onClose }: { runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const plugins = addablePlugins(runner);
  const [pluginId, setPluginId] = useState(plugins.find((p) => p.healthy)?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const { saving, error, submit } = useSubmit(onClose);
  const plugin = plugins.find((p) => p.id === pluginId);
  const fields = plugin?.addFields ?? [];
  const missing = fields.some((f) => f.required && !values[f.id]?.trim());
  return (
    <form className="fleet-guide" onSubmit={(e) => void submit(e, () => send("AddPluginAgent", { runner: runner.name, plugin: pluginId, fields: values }))}>
      <fieldset className="fleet-choice-field">
        <legend className="field-label fleet-choice-legend">Runs with</legend>
        <div className="fleet-choice-grid">
          {plugins.map((p) => (
            <ChoiceCard
              key={p.id}
              type="radio"
              name="plugin"
              value={p.id}
              checked={pluginId === p.id}
              disabled={!p.healthy}
              title={p.name}
              detail={p.healthy ? PLUGIN_BLURBS[p.id] ?? `Agents run by the ${p.name} plugin.` : `Unavailable on ${runnerLabel(runner)}: ${p.detail}`}
              onChange={() => {
                setPluginId(p.id);
                setValues({});
              }}
            />
          ))}
        </div>
      </fieldset>
      {fields.map((f) => (
        <label key={`${pluginId}/${f.id}`} className="field">
          <span className="field-label">
            {f.label}
            {!f.required && <span className="field-optional"> (optional)</span>}
          </span>
          <input
            className={`field-input${f.kind === "path" ? " mono" : ""}`}
            value={values[f.id] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            placeholder={f.placeholder}
            spellCheck={f.kind === "text"}
            autoFocus={f === fields[0]}
          />
          {f.hint && <span className="field-hint">{f.hint}</span>}
        </label>
      ))}
      <ErrorLine error={error} />
      <Actions saving={saving} disabled={!plugin || missing} label="Add agent" onClose={onClose} />
    </form>
  );
}

const PLUGIN_BLURBS: Record<string, string> = {
  python: "A folder on the runner with an agent.py.",
  docker: "A container image that speaks the agent contract.",
  "claude-code": "Claude Code working in a project folder.",
  agentcore: "A runtime deployed to Bedrock AgentCore.",
};

export function AddAgentDialog({ model, runner, send, onClose }: { model: FleetModel; runner: FleetRunner; send: FleetSend; onClose: () => void }) {
  const offer = addAgentModes(runner);
  const [mode, setMode] = useState<Mode>("modes" in offer ? offer.modes[0]! : "create");
  return (
    <FleetDialog title={`Add agent to ${runnerLabel(runner)}`} onClose={onClose}>
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
          <p className="field-hint">{MODE_HINTS[mode]}</p>
          {mode === "create" ? (
            <AgentSpecForm
              model={model}
              runner={runner}
              label="Create agent"
              onSave={(spec) => send("CreateAgent", { runner: runner.name, ...spec })}
              onClose={onClose}
            />
          ) : (
            <ExistingAgentForm runner={runner} send={send} onClose={onClose} />
          )}
        </>
      )}
    </FleetDialog>
  );
}
