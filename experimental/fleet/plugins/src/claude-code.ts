/** Claude Code agents: a project folder run with `claude -p` once per task; follow-ups resume the session (claude-code/README.md). */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agentInfo,
  count,
  DESCRIPTION_FIELD,
  existingFolder,
  folderAdding,
  list,
  NAME_FIELD,
  readAgentFolders,
  stringMap,
  strings,
  text,
  type AgentFolder,
} from "./agents.js";
import { fail, ok, type AddField, type AgentInfo, type Harness, type RunEvent } from "./protocol.js";
import { capture, oneShot } from "./process.js";

const HEALTH_TIMEOUT_MS = 20_000;
/** `claude -p` needs a prompt; agents meant to run without input still get one. */
export const NO_INPUT = "Go.";
const STATUS_CHARS = 120;

export type ClaudeAgent = {
  info: AgentInfo;
  project: string;
  model?: string;
  allowedTools: string[];
  permissionMode?: string;
  systemPrompt?: string;
  maxTurns?: number;
  env: Record<string, string>;
};

const toAgent = (folder: AgentFolder): ClaudeAgent => {
  const m = folder.manifest;
  const project = (text(m, "project") ?? ".").replace(/^~(?=$|\/)/, os.homedir());
  const optional = {
    model: text(m, "model"),
    permissionMode: text(m, "permission_mode"),
    systemPrompt: text(m, "system_prompt"),
    maxTurns: typeof m.max_turns === "number" ? m.max_turns : undefined,
  };
  return {
    info: agentInfo(folder),
    project: path.resolve(folder.dir, project),
    allowedTools: strings(m, "allowed_tools"),
    env: stringMap(m, "env"),
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
};

const load = async (dir: string): Promise<ClaudeAgent[]> => (await readAgentFolders(dir)).map(toAgent);

const FIELDS: AddField[] = [
  NAME_FIELD,
  { id: "project", label: "Project folder", kind: "path", required: true, hint: "the folder Claude Code works in, on the runner's machine", placeholder: "/home/me/repos/app" },
  { id: "allowed_tools", label: "Allowed tools", kind: "list", hint: "comma-separated; without them it can't use tools that need approval", placeholder: "Read, Grep, Glob" },
  { id: "model", label: "Model", kind: "text", hint: "Claude Code's default otherwise", placeholder: "sonnet" },
  DESCRIPTION_FIELD,
];

export const claudeArgs = (agent: ClaudeAgent, prompt: string, resume: string | undefined): string[] => [
  "-p",
  prompt || NO_INPUT,
  "--output-format",
  "stream-json",
  "--verbose",
  ...(agent.model ? ["--model", agent.model] : []),
  ...(agent.allowedTools.length > 0 ? ["--allowedTools", agent.allowedTools.join(",")] : []),
  ...(agent.permissionMode ? ["--permission-mode", agent.permissionMode] : []),
  ...(agent.systemPrompt ? ["--append-system-prompt", agent.systemPrompt] : []),
  ...(agent.maxTurns ? ["--max-turns", String(agent.maxTurns)] : []),
  ...(resume ? ["--resume", resume] : []),
];

const short = (s: string): string => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length <= STATUS_CHARS ? line : `${line.slice(0, STATUS_CHARS - 1)}…`;
};

type Part = { type?: unknown; text?: unknown; name?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A line of `claude -p --output-format stream-json` as run events; hands any session id to `onSession`. */
export const translate = (line: string, onSession: (id: string) => void = () => {}): RunEvent[] => {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(m)) return [];
  if (typeof m.session_id === "string") onSession(m.session_id);
  if (m.type === "system" && m.subtype === "init") return [{ status: `Claude Code started (${typeof m.model === "string" ? m.model : "default model"})` }];
  if (m.type === "assistant") {
    const content = isRecord(m.message) && Array.isArray(m.message.content) ? (m.message.content as Part[]) : [];
    const tools = content.filter((c) => c.type === "tool_use").map((c) => (typeof c.name === "string" ? c.name : "a tool"));
    const texts = content.filter((c) => c.type === "text" && typeof c.text === "string" && c.text.trim()).map((c) => c.text as string);
    if (tools.length > 0) return [{ status: `using ${tools.join(", ")}` }];
    const last = texts.at(-1);
    return last ? [{ status: short(last) }] : [];
  }
  if (m.type === "result") {
    const result = typeof m.result === "string" ? m.result : "";
    if (m.is_error === true || m.subtype !== "success") return [{ error: result || `Claude Code stopped: ${typeof m.subtype === "string" ? m.subtype : "error"}` }];
    return [{ artifact: { name: "reply", text: result } }, { status: "answered" }];
  }
  return [];
};

/** Claude Code session ids by `<agent>/<contextId>`, in one JSON file. */
export function sessionStore(file: string) {
  const read = async (): Promise<Record<string, string>> =>
    readFile(file, "utf8")
      .then((t) => JSON.parse(t) as Record<string, string>)
      .catch(() => ({}));
  let writes = Promise.resolve();
  return {
    get: async (key: string): Promise<string | undefined> => (await read())[key],
    /** Serialized, and written to a temp file then renamed, so a crash never leaves half a file. */
    set: (key: string, id: string): Promise<void> => {
      writes = writes.then(async () => {
        const known = await read();
        if (known[key] === id) return;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify({ ...known, [key]: id }));
        await rename(`${file}.tmp`, file);
      });
      return writes;
    },
  };
}

export function claudeCodeHarness(dir: string, claude: [string, ...string[]], stateFile: string): Harness {
  const [cli, ...pre] = claude;
  const sessions = sessionStore(stateFile);
  return {
    name: "Claude Code",
    version: "1",
    capabilities: ["cancel", "conversations"],
    health: async () => {
      const version = await capture(cli, [...pre, "--version"], HEALTH_TIMEOUT_MS);
      if (!version.ok) return { ok: false, detail: `claude isn't usable: ${version.error}` };
      return { ok: true, detail: `${version.stdout}, ${count((await load(dir)).length, "agent", "agents")}` };
    },
    agents: async () => (await load(dir)).map((a) => a.info),
    prepare: async (task) => {
      const agent = (await load(dir)).find((a) => a.info.id === task.agent);
      if (!agent) return fail(`there is no Claude Code agent ${JSON.stringify(task.agent)}`);
      const isDir = await stat(agent.project).then((s) => s.isDirectory(), () => false);
      if (!isDir) return fail(`${agent.info.id}'s project folder ${agent.project} doesn't exist`);
      const key = `${agent.info.id}/${task.contextId}`;
      const resume = await sessions.get(key);
      const remember = (id: string) => void sessions.set(key, id);
      return ok((emit, signal) =>
        oneShot(
          {
            command: cli,
            args: [...pre, ...claudeArgs(agent, task.input, resume)],
            cwd: agent.project,
            env: { ...process.env, ...agent.env, FLEET_TASK_ID: task.taskId },
            stdin: "",
            label: agent.info.id,
          },
          task,
          emit,
          signal,
          (line) => translate(line, remember),
        ),
      );
    },
    adding: folderAdding(dir, FIELDS, async (values) => {
      const project = await existingFolder(values.project ?? "", "Project folder");
      return project.ok ? ok({ project: project.value, allowed_tools: list(values.allowed_tools), model: values.model }) : project;
    }),
  };
}
