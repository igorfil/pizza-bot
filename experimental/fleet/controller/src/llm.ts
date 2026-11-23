import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";
import type { Outcome } from "./outcome.js";
import type { LlmTurn } from "./types.js";

const MODEL = process.env.FLEET_CHAT_MODEL ?? "us.anthropic.claude-haiku-5-5";
const TIMEOUT_MS = 60_000;
// Newer models spend output tokens before the visible text; small limits cut replies short.
const MAX_TOKENS = 4096;

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-west-2" });

const toMessage = (turn: LlmTurn): Message => ({ role: turn.role, content: [{ text: turn.text }] });

export const chatModel = (): string => MODEL;

export const complete = async (system: string, turns: LlmTurn[]): Promise<Outcome<string>> => {
  try {
    const res = await client.send(
      new ConverseCommand({
        modelId: MODEL,
        system: [{ text: system }],
        messages: turns.map(toMessage),
        inferenceConfig: { maxTokens: MAX_TOKENS },
      }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const text = (res.output?.message?.content ?? [])
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (!text) return { ok: false, error: "The model returned no text." };
    return { ok: true, value: res.stopReason === "max_tokens" ? `${text}\n\n_(cut off: the model hit its output limit)_` : text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
