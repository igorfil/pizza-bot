/** Container agents: each is an image run with `docker run -i` once per task; cancel kills the container (docker/README.md). */
import { agentInfo, count, DESCRIPTION_FIELD, folderAdding, list, NAME_FIELD, readAgentFolders, stringMap, strings, text, type AgentFolder } from "./agents.js";
import { fail, ok, type AddField, type AgentInfo, type Harness } from "./protocol.js";
import { capture, oneShot } from "./process.js";

const HEALTH_TIMEOUT_MS = 10_000;

export type DockerAgent = { info: AgentInfo; image: string; command: string[]; args: string[]; env: Record<string, string> };

const toAgent = (folder: AgentFolder): DockerAgent | null => {
  const image = text(folder.manifest, "image");
  if (!image) {
    process.stderr.write(`skipping ${folder.id}: agent.toml needs an image\n`);
    return null;
  }
  return { info: agentInfo(folder), image, command: strings(folder.manifest, "command"), args: strings(folder.manifest, "args"), env: stringMap(folder.manifest, "env") };
};

const load = async (dir: string): Promise<DockerAgent[]> => (await readAgentFolders(dir)).map(toAgent).filter((a): a is DockerAgent => a !== null);

const FIELDS: AddField[] = [
  NAME_FIELD,
  { id: "image", label: "Image", kind: "text", required: true, hint: "speaks the agent contract on stdin and stdout", placeholder: "ghcr.io/acme/report-agent:1" },
  { id: "command", label: "Command", kind: "list", hint: "replaces the image's command, comma-separated", placeholder: "python, agent.py" },
  { id: "args", label: "docker run flags", kind: "list", hint: "comma-separated, e.g. --network, none", placeholder: "--network, none" },
  DESCRIPTION_FIELD,
];

/** An image reference docker accepts: no spaces, nothing that starts like a flag. */
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]*$/i;

/** A name docker accepts, unique per run, so cancel can find the container. */
export const containerName = (taskId: string): string => `fleet-${taskId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;

/** `docker run` for one task, after the CLI words in `docker` (e.g. ["docker"] or ["podman"]). */
export const runArgs = (agent: DockerAgent, taskId: string): string[] => [
  "run",
  "--rm",
  "-i",
  "--init",
  "--name",
  containerName(taskId),
  ...Object.entries({ ...agent.env, FLEET_TASK_ID: taskId }).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
  ...agent.args,
  agent.image,
  ...agent.command,
];

export function dockerHarness(dir: string, docker: [string, ...string[]]): Harness {
  const [cli, ...pre] = docker;
  return {
    name: "Docker",
    version: "1",
    capabilities: ["cancel"],
    health: async () => {
      const version = await capture(cli, [...pre, "version", "--format", "{{.Server.Version}}"], HEALTH_TIMEOUT_MS);
      if (!version.ok) return { ok: false, detail: `docker isn't usable: ${version.error}` };
      return { ok: true, detail: `Docker ${version.stdout}, ${count((await load(dir)).length, "agent", "agents")}` };
    },
    agents: async () => (await load(dir)).map((a) => a.info),
    prepare: async (task) => {
      const agent = (await load(dir)).find((a) => a.info.id === task.agent);
      if (!agent) return fail(`there is no Docker agent ${JSON.stringify(task.agent)}`);
      const stop = async () => {
        await capture(cli, [...pre, "kill", containerName(task.taskId)], HEALTH_TIMEOUT_MS);
      };
      return ok((emit, signal) => oneShot({ command: cli, args: [...pre, ...runArgs(agent, task.taskId)], label: agent.info.id, stop }, task, emit, signal));
    },
    adding: folderAdding(dir, FIELDS, async (values) => {
      const image = values.image ?? "";
      if (!IMAGE.test(image)) return fail(`${JSON.stringify(image)} isn't an image reference, like ghcr.io/acme/agent:1`);
      return ok({ image, command: list(values.command), args: list(values.args) });
    }),
  };
}
