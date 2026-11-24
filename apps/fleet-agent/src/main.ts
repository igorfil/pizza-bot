#!/usr/bin/env node
/** Runs one fleet task in the agent folder that is the working directory; stdout carries only contract events. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_EVAL_TOOL_REF, ModelRegistry, projectSkillReadiness } from "@pizza-bot/core";
import { registerBuiltinProviders } from "@pizza-bot/inference-providers";
import { connectMcpServers, expandMcpEnvVars, loadUserMcpServers, loadUserSkills } from "@pizza-bot/plugin-sdk";
import { createPizzaBotAgent } from "@pizza-bot/runtime-langgraph";
import { openPersistence } from "@pizza-bot/storage";
import { mcpStates, qualifyModel, systemPromptFor, withServerSkills } from "./agent-folder.js";
import { finalReply, parseInput, statusFor, type ContractEvent } from "./contract.js";

// Created agents run with no input ("random fact"); the model still needs a user turn.
const NO_INPUT = "Go.";
const MCP_CONNECT_TIMEOUT_MS = 20_000;

const emit = (event: ContractEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const readOptional = (file: string): Promise<string> => readFile(file, "utf8").catch(() => "");

const run = async (signal: AbortSignal): Promise<number> => {
  const task = parseInput(await readStdin());
  const dir = process.cwd();
  const modelSetting = process.env.MODEL?.trim();
  if (!modelSetting) {
    emit({ error: "MODEL is not set in agent.toml [env]" });
    return 1;
  }

  const registry = new ModelRegistry();
  await registerBuiltinProviders(registry);
  const modelId = qualifyModel(modelSetting, new Set(registry.listProviders().map((p) => p.id)));
  const model = await registry.buildModel(modelId);

  const servers = expandMcpEnvVars(
    await loadUserMcpServers(path.join(dir, ".mcp.json"), (file, err) => log(`[mcp] skipping ${file}: ${String(err)}`)),
  );
  const serverIds = Object.keys(servers);
  if (serverIds.length > 0) emit({ status: `connecting ${serverIds.join(", ")}` });
  const mcp = await connectMcpServers(servers, undefined, (m) => log(`[mcp] ${m}`), "pipe", registry.collectProcessEnv(), {
    connectionTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
  });
  Object.entries(mcp.errors).forEach(([server, error]) => log(`[mcp] ${server} unavailable: ${error}`));

  const persistence = await openPersistence({ root: process.env.FLEET_AGENT_STATE ?? path.join(dir, ".state") });
  try {
    const skills = withServerSkills(await loadUserSkills(path.join(dir, "skills"), (m) => log(`[skills] ${m}`)), mcp.catalog);
    const { ready, availability } = projectSkillReadiness(skills, {
      catalog: mcp.catalog,
      tools: new Set(Object.keys(mcp.tools)),
      mcpServers: mcpStates(serverIds, mcp.catalog, mcp.errors),
      builtins: new Set([BUILTIN_EVAL_TOOL_REF]),
    });
    availability.filter((s) => s.status !== "ready").forEach((s) => log(`[skills] ${s.name} unavailable: ${s.detail ?? s.status}`));

    const agent = await createPizzaBotAgent(systemPromptFor(await readOptional(path.join(dir, "system.md")), ready.size > 0), {
      checkpointer: persistence.checkpointer,
      store: persistence.store,
      model,
      tools: mcp.tools,
      catalog: mcp.catalog,
      skills: ready,
      skillAvailability: availability,
      logger: { info: log, warn: log, error: log, debug: () => {} },
    });

    const threadId = task.contextId || task.taskId || randomUUID();
    emit({ status: `thinking with ${modelId}` });
    const frames = agent.streamProtocol(
      { messages: [{ id: randomUUID(), role: "user", parts: [{ type: "text", text: task.input.trim() || NO_INPUT }] }] },
      { threadId, signal },
    );
    for await (const frame of frames) {
      const status = statusFor(frame);
      if (status) emit({ status });
    }

    const state = await agent.getState(threadId);
    if ((state.interrupts?.length ?? 0) > 0) {
      emit({ error: "the agent asked for an approval, and fleet runs can't answer approvals yet" });
      return 1;
    }
    const reply = finalReply(state.values.messages ?? []);
    if (!reply) {
      emit({ error: "the agent finished without a reply" });
      return 1;
    }
    emit({ artifact: { name: "reply", text: reply } });
    emit({ status: "answered" });
    return 0;
  } finally {
    await mcp.client?.close().catch(() => {});
    persistence.close();
  }
};

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());

run(controller.signal).then(
  (code) => process.exit(code),
  (err: unknown) => {
    emit({ error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);
