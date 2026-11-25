/** AgentCore Runtime agents: a deployed runtime invoked once per task; one conversation is one runtime session (agentcore/README.md). */
import { createHash } from "node:crypto";
import { InvokeAgentRuntimeCommand, StopRuntimeSessionCommand, type BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { agentInfo, count, readAgentFolders, text, type AgentFolder } from "./agents.js";
import { fail, message, ok, type AgentInfo, type Harness, type RunEvent } from "./protocol.js";

const DEFAULT_QUALIFIER = "DEFAULT";
const TEXT_KEYS = ["result", "response", "output", "text", "message", "content"];

export type AgentCoreAgent = { info: AgentInfo; arn: string; qualifier: string; region: string; payloadKey: string };

/** The client calls the plugin makes; a test passes a fake. */
export type AgentCoreClient = Pick<BedrockAgentCoreClient, "send">;

/** arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id> */
export const regionOf = (arn: string): string | null => {
  const parts = arn.split(":");
  return parts.length > 5 && parts[2] === "bedrock-agentcore" && parts[3] ? parts[3] : null;
};

const toAgent = (folder: AgentFolder): AgentCoreAgent | null => {
  const m = folder.manifest;
  const arn = text(m, "runtime_arn");
  const region = text(m, "region") ?? (arn ? regionOf(arn) : null);
  if (!arn || !region) {
    process.stderr.write(`skipping ${folder.id}: agent.toml needs runtime_arn, an AgentCore Runtime ARN\n`);
    return null;
  }
  return { info: agentInfo(folder), arn, region, qualifier: text(m, "qualifier") ?? DEFAULT_QUALIFIER, payloadKey: text(m, "payload_key") ?? "prompt" };
};

const load = async (dir: string): Promise<AgentCoreAgent[]> => (await readAgentFolders(dir)).map(toAgent).filter((a): a is AgentCoreAgent => a !== null);

/** One runtime session per conversation; AgentCore wants at least 33 characters. */
export const sessionId = (agentId: string, contextId: string): string => `fleet-${createHash("sha256").update(`${agentId}/${contextId}`).digest("hex").slice(0, 40)}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The answer in a JSON reply: a string, a common text field, or the JSON itself. */
export const replyText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const found = TEXT_KEYS.map((k) => value[k]).find((v): v is string => typeof v === "string");
    if (found !== undefined) return found;
  }
  return JSON.stringify(value);
};

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const isEvent = (v: unknown): v is RunEvent => isRecord(v) && ("status" in v || "artifact" in v || "error" in v);

/** Server-sent events from a streaming runtime: contract events pass through, other data joins into the reply. */
export const streamEvents = (lines: string[]): RunEvent[] => {
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => parse(l.slice(5).trim()));
  const reply = data.filter((v) => !isEvent(v)).map(replyText).join("");
  return [...data.filter(isEvent), ...(reply ? [{ artifact: { name: "reply", text: reply } }] : [])];
};

/** Run events from an InvokeAgentRuntime reply body. */
export const relay = (contentType: string, body: string): RunEvent[] => {
  if (contentType.includes("text/event-stream")) return streamEvents(body.split(/\r?\n/));
  const value = parse(body);
  return isRecord(value) && typeof value.error === "string" ? [{ error: value.error }] : [{ artifact: { name: "reply", text: replyText(value) } }];
};

export function agentCoreHarness(agentsDir: string, client: (region: string) => AgentCoreClient, hasCredentials: () => Promise<boolean>): Harness {
  return {
    name: "AgentCore",
    version: "1",
    capabilities: ["cancel", "conversations"],
    health: async () =>
      (await hasCredentials())
        ? { ok: true, detail: count((await load(agentsDir)).length, "runtime", "runtimes") }
        : { ok: false, detail: "no AWS credentials for this runner" },
    agents: async () => (await load(agentsDir)).map((a) => a.info),
    prepare: async (task) => {
      const agent = (await load(agentsDir)).find((a) => a.info.id === task.agent);
      if (!agent) return fail(`there is no AgentCore agent ${JSON.stringify(task.agent)}`);
      const session = sessionId(agent.info.id, task.contextId);
      const runtime = client(agent.region);
      return ok(async (emit, signal) => {
        const stop = () =>
          void runtime
            .send(new StopRuntimeSessionCommand({ agentRuntimeArn: agent.arn, runtimeSessionId: session, qualifier: agent.qualifier }))
            .catch((e: unknown) => process.stderr.write(`couldn't stop session ${session}: ${message(e)}\n`));
        signal.addEventListener("abort", stop, { once: true });
        emit({ status: `invoking ${agent.arn.split("/").at(-1) ?? agent.arn}` });
        try {
          const reply = await runtime.send(
            new InvokeAgentRuntimeCommand({
              agentRuntimeArn: agent.arn,
              qualifier: agent.qualifier,
              runtimeSessionId: session,
              payload: new TextEncoder().encode(JSON.stringify({ [agent.payloadKey]: task.input })),
            }),
            { abortSignal: signal },
          );
          relay(reply.contentType ?? "", (await reply.response?.transformToString()) ?? "").forEach(emit);
          return null;
        } catch (e) {
          return signal.aborted ? null : message(e);
        } finally {
          signal.removeEventListener("abort", stop);
        }
      });
    },
  };
}
