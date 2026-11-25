import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { afterEach, describe, expect, it } from "vitest";
import { agentCoreHarness, regionOf, relay, replyText, sessionId, streamEvents, type AgentCoreClient } from "./agentcore.js";
import type { RunEvent } from "./protocol.js";

/** The plugin's shipped agents in `dir`, and the ones added from the Fleet page inside it (a folder without agent.toml). */
const dirsOf = (dir: string) => ({ shipped: dir, added: path.join(dir, ".added") });



const ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/support_agent-AbC123";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

const agentsDir = (toml: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-agentcore-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "support"));
  writeFileSync(path.join(dir, "support", "agent.toml"), toml);
  return dir;
};

type Sent = { name: string; input: unknown };

/** Records what the plugin sends and answers like the service would; `reply` throws to act as a refusal. */
const fakeClient = (reply: (command: unknown, signal?: AbortSignal) => Promise<unknown>) => {
  const sent: Sent[] = [];
  const client = {
    send: async (command: { input: unknown; constructor: { name: string } }, options?: { abortSignal?: AbortSignal }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return reply(command, options?.abortSignal);
    },
  } as unknown as AgentCoreClient;
  return { client, sent };
};

const body = (contentType: string, text: string) => ({ contentType, response: { transformToString: async () => text } });

describe("AgentCore runtimes", () => {
  it("take the region from the runtime ARN", () => {
    expect([regionOf(ARN), regionOf("arn:aws:s3:::bucket"), regionOf("nope")]).toEqual(["us-west-2", null, null]);
  });

  it("keep one session per conversation, long enough for AgentCore", () => {
    const [a, b, other] = [sessionId("support", "c1"), sessionId("support", "c1"), sessionId("support", "c2")];
    expect([a === b, a === other, a.length >= 33]).toEqual([true, false, true]);
  });

  it("are listed from agent folders with a runtime ARN, and skipped without one", async () => {
    const harness = (toml: string) => agentCoreHarness(dirsOf(agentsDir(toml)), () => fakeClient(async () => ({})).client, async () => true);
    expect([await harness(`name = "Support"\nruntime_arn = "${ARN}"\n`).agents(), await harness('name = "No ARN"\n').agents()]).toEqual([[{ id: "support", name: "Support" }], []]);
  });
});

describe("AgentCore replies", () => {
  it("take the text from a JSON reply", () => {
    expect([replyText("hi"), replyText({ result: "ok" }), replyText({ n: 1 })]).toEqual(["hi", "ok", '{"n":1}']);
  });

  it("join streamed text into one reply and pass contract events through", () => {
    expect(streamEvents(['data: {"status": "thinking"}', ": keepalive", 'data: "Hel"', 'data: "lo"'])).toEqual([{ status: "thinking" }, { artifact: { name: "reply", text: "Hello" } }]);
  });

  it("fail the run on a JSON error reply", () => {
    expect(relay("application/json", '{"error": "quota"}')).toEqual([{ error: "quota" }]);
  });
});

describe("an AgentCore run", () => {
  const run = async (reply: (command: unknown, signal?: AbortSignal) => Promise<unknown>, controller = new AbortController(), contextId = "c1") => {
    const { client, sent } = fakeClient(reply);
    const harness = agentCoreHarness(dirsOf(agentsDir(`name = "Support"\nruntime_arn = "${ARN}"\n`)), () => client, async () => true);
    const job = await harness.prepare({ taskId: "t1", contextId, agent: "support", input: "hi" });
    const events: RunEvent[] = [];
    const reason = job.ok ? await job.value((e) => events.push(e), controller.signal) : job.error;
    return { events, reason, sent };
  };

  it("invokes the runtime in the conversation's session and relays the reply", async () => {
    const { events, reason, sent } = await run(async () => body("application/json", '{"result": "hello"}'));
    const invoke = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: ARN,
      qualifier: "DEFAULT",
      runtimeSessionId: sessionId("support", "c1"),
      payload: new TextEncoder().encode(JSON.stringify({ prompt: "hi" })),
    });
    expect([events.slice(1), reason, sent]).toEqual([[{ artifact: { name: "reply", text: "hello" } }], null, [{ name: invoke.constructor.name, input: invoke.input }]]);
  });

  it("fails with the service's reason when the call is refused", async () => {
    const { reason } = await run(async () => {
      throw new Error("User is not authorized to perform: bedrock-agentcore:InvokeAgentRuntime");
    });
    expect(reason).toContain("not authorized");
  });

  it("stops the runtime session on cancel, without a failure", async () => {
    const controller = new AbortController();
    const waitForAbort = (_command: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    setTimeout(() => controller.abort(), 50);
    const { reason, sent } = await run(async (command, signal) => (command instanceof StopRuntimeSessionCommand ? {} : waitForAbort(command, signal)), controller);
    expect([reason, sent.at(-1)]).toEqual([
      null,
      { name: StopRuntimeSessionCommand.name, input: { agentRuntimeArn: ARN, runtimeSessionId: sessionId("support", "c1"), qualifier: "DEFAULT" } },
    ]);
  });

  it("is unhealthy without AWS credentials", async () => {
    expect(await agentCoreHarness(dirsOf(os.tmpdir()), () => fakeClient(async () => ({})).client, async () => false).health()).toEqual({ ok: false, detail: "no AWS credentials for this runner" });
  });
});

describe("adding AgentCore agents", () => {
  const harness = () => agentCoreHarness(dirsOf(agentsDir(`name = "Support"\nruntime_arn = "${ARN}"\n`)), () => fakeClient(async () => ({})).client, async () => true);

  it("adds a runtime by its ARN", async () => {
    const h = harness();
    const added = await h.adding!.add({ name: "Billing", runtime_arn: ARN.replace("support_agent", "billing") });
    expect([added, (await h.agents()).map((a) => [a.id, a.added ?? false])]).toEqual([{ ok: true, value: "billing" }, [["billing", true], ["support", false]]]);
  });

  it("refuses something that isn't a runtime ARN", async () => {
    expect((await harness().adding!.add({ name: "Bad", runtime_arn: "arn:aws:s3:::bucket" })).ok).toBe(false);
  });
});
