/** Plain Python agents: each folder is one agent, its `agent.py` run once per task (python/README.md). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { agentInfo, count, readAgentFolders, stringMap, text, type AgentFolder } from "./agents.js";
import { fail, ok, type AgentInfo, type Harness } from "./protocol.js";
import { oneShot } from "./process.js";

type PythonAgent = { info: AgentInfo; dir: string; command: string; env: Record<string, string> };

/** A script with inline dependencies (PEP 723) runs with uv, which installs them; any other with python3. */
export const defaultCommand = (script: string | null): string => (script?.includes("# /// script") ? "uv run --quiet agent.py" : "python3 agent.py");

const toAgent = async (folder: AgentFolder): Promise<PythonAgent> => {
  const command = text(folder.manifest, "command") ?? defaultCommand(await readFile(path.join(folder.dir, "agent.py"), "utf8").catch(() => null));
  return { info: agentInfo(folder), dir: folder.dir, command, env: stringMap(folder.manifest, "env") };
};

const load = async (dir: string): Promise<PythonAgent[]> => Promise.all((await readAgentFolders(dir)).map(toAgent));

export function pythonHarness(agentsDir: string): Harness {
  return {
    name: "Python",
    version: "1",
    capabilities: ["cancel"],
    health: async () => ({ ok: true, detail: `${count((await load(agentsDir)).length, "agent", "agents")} in ${agentsDir}` }),
    agents: async () => (await load(agentsDir)).map((a) => a.info),
    prepare: async (task) => {
      const agent = (await load(agentsDir)).find((a) => a.info.id === task.agent);
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
  };
}
