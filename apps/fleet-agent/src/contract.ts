/** The fleet runner's agent contract: JSON input on stdin, one JSON event per stdout line. */
/** The slice of a LangGraph protocol frame this harness reads. */
export type Frame = { method: string; params: { data?: unknown } };

export type TaskInput = { taskId: string; contextId: string; input: string };

export type ContractEvent =
  | { status: string }
  | { artifact: { name: string; text: string } }
  | { error: string };

export const parseInput = (raw: string): TaskInput => {
  const value = JSON.parse(raw || "{}") as Partial<Record<keyof TaskInput, unknown>>;
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  return { taskId: text(value.taskId), contextId: text(value.contextId), input: text(value.input) };
};

/** Tool input arrives as an object or as its JSON text. */
const argsOf = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "string") return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Delegations name the skill doing the work; everything else names the tool. */
export const statusFor = (event: Frame): string | null => {
  if (event.method !== "tools") return null;
  const data = (event.params.data ?? {}) as { event?: string; tool_name?: string; input?: unknown };
  if (data.event !== "tool-started" || !data.tool_name) return null;
  const subagent = argsOf(data.input).subagent_type;
  return data.tool_name === "task" && typeof subagent === "string" ? `working with ${subagent}` : `using ${data.tool_name}`;
};

type MessageLike = {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  _getType?: () => string;
};

const roleOf = (m: MessageLike): string =>
  typeof m._getType === "function" ? m._getType() : typeof m.type === "string" ? m.type : String(m.role ?? "");

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: { type?: unknown; text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
          .join("")
      : "";

/** The reply is the last assistant message that says something. */
export const finalReply = (messages: readonly unknown[]): string =>
  [...messages]
    .reverse()
    .map((m) => m as MessageLike)
    .filter((m) => ["ai", "assistant"].includes(roleOf(m)))
    .map((m) => textOf(m.content).trim())
    .find((text) => text.length > 0) ?? "";
