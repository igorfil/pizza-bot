/** Plain Python agents: each folder is one agent, its `agent.py` run once per task (python/README.md). */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { agentInfo, count, DESCRIPTION_FIELD, existingFolder, folderAdding, NAME_FIELD, readAgentFolders, stringMap, text, type AgentFolder } from "./agents.js";
import { fail, ok, type AddField, type AgentInfo, type Harness } from "./protocol.js";
import { oneShot } from "./process.js";

type PythonAgent = { info: AgentInfo; dir: string; command: string; env: Record<string, string> };

/** A script with inline dependencies (PEP 723) runs with uv, which installs them; any other with python3. */
export const defaultCommand = (script: string | null): string => (script?.includes("# /// script") ? "uv run --quiet agent.py" : "python3 agent.py");

/** An agent's manifest points at its folder elsewhere on the machine with `path`; without one, the agent is its own folder. */
const toAgent = async (folder: AgentFolder): Promise<PythonAgent> => {
  const dir = text(folder.manifest, "path") ?? folder.dir;
  const command = text(folder.manifest, "command") ?? defaultCommand(await readFile(path.join(dir, "agent.py"), "utf8").catch(() => null));
  return { info: agentInfo(folder), dir, command, env: stringMap(folder.manifest, "env") };
};

const load = async (dir: string): Promise<PythonAgent[]> => Promise.all((await readAgentFolders(dir)).map(toAgent));

const FIELDS: AddField[] = [
  NAME_FIELD,
  { id: "path", label: "Folder", kind: "path", required: true, hint: "the agent's folder on the runner's machine, with its agent.py", placeholder: "/srv/agents/weekly-report" },
  { id: "command", label: "Command", kind: "text", hint: "how to start it in that folder, if not agent.py", placeholder: "python3 agent.py" },
  DESCRIPTION_FIELD,
];

export function pythonHarness(dir: string): Harness {
  return {
    name: "Python",
    version: "1",
    capabilities: ["cancel"],
    health: async () => ({ ok: true, detail: `${count((await load(dir)).length, "agent", "agents")}` }),
    agents: async () => (await load(dir)).map((a) => a.info),
    prepare: async (task) => {
      const agent = (await load(dir)).find((a) => a.info.id === task.agent);
      if (!agent) return fail(`there is no Python agent ${JSON.stringify(task.agent)}`);
      return ok((emit, signal) =>
        oneShot(
          { command: "sh", args: ["-c", agent.command], cwd: agent.dir, env: { ...process.env, ...agent.env, FLEET_TASK_ID: task.taskId }, label: agent.info.id },
          task,
          emit,
          signal,
        ),
      );
    },
    adding: folderAdding(dir, FIELDS, async (values) => {
      const folder = await existingFolder(values.path ?? "", "Folder");
      if (!folder.ok) return folder;
      const hasScript = await stat(path.join(folder.value, "agent.py")).then((s) => s.isFile(), () => false);
      if (!hasScript && !values.command) return fail(`${folder.value} has no agent.py; say how to start the agent in Command`);
      return ok({ path: folder.value, command: values.command });
    }),
  };
}
