import type { Chat, ChatMessage, Effect, LlmTurn, Model, Task } from "./types.ts";

export const CHAT_SYSTEM =
  "You are the assistant inside an agent-fleet dashboard. Be concise and practical. " +
  "When the conversation includes an agent result, help the user understand it and decide what to do next.";

const TITLE_LEN = 48;

const titleFrom = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > TITLE_LEN ? `${line.slice(0, TITLE_LEN - 1)}…` : line || "New chat";
};

/** Text of a finished run, as background for a chat started from the inbox. */
export const taskContext = (task: Task): string =>
  [
    `Agent: ${task.runner}/${task.agent}`,
    `Input: ${task.prompt || "(none)"}`,
    `Outcome: ${task.state}${task.statusText ? ` (${task.statusText})` : ""}`,
    ...task.artifacts.map((a) => `--- ${a.name || a.id} ---\n${a.text}`),
  ].join("\n");

const systemPrompt = (chat: Chat): string =>
  chat.context ? `${CHAT_SYSTEM}\n\nBackground: an agent run the user is asking about.\n${chat.context.text}` : CHAT_SYSTEM;

const turns = (chat: Chat): LlmTurn[] => chat.messages.map((m) => ({ role: m.role, text: m.text }));

const setChat = (model: Model, chat: Chat): Model => ({
  ...model,
  chats: { ...model.chats, [chat.id]: { ...chat, updatedAt: model.now } },
});

/** Ids derive from position so replaying the log reproduces them. */
const message = (chat: Chat, role: ChatMessage["role"], text: string, at: number): ChatMessage => ({
  id: `${chat.id}:${chat.messages.length}`,
  role,
  text,
  at,
});

const ask = (model: Model, chat: Chat, text: string): [Model, Effect[]] => {
  const asked: Chat = { ...chat, messages: [...chat.messages, message(chat, "user", text, model.now)], pending: true, error: null };
  return [setChat(model, asked), [{ type: "ChatComplete", chatId: chat.id, system: systemPrompt(asked), turns: turns(asked) }]];
};

export const createChat = (model: Model, chatId: string, fromTaskId: string | null, text: string): [Model, Effect[]] => {
  const task = fromTaskId ? model.tasks[fromTaskId] : undefined;
  const chat: Chat = {
    id: chatId,
    title: task ? `${task.agent}: ${task.prompt || task.state}` : titleFrom(text),
    context: task ? { taskId: task.id, text: taskContext(task) } : null,
    messages: [],
    pending: false,
    error: null,
    createdAt: model.now,
    updatedAt: model.now,
  };
  return text.trim() ? ask(model, chat, text.trim()) : [setChat(model, chat), []];
};

export const sendChatMessage = (model: Model, chatId: string, text: string): [Model, Effect[]] => {
  const chat = model.chats[chatId];
  if (!chat || chat.pending || !text.trim()) return [model, []];
  const titled = chat.messages.length === 0 && !chat.context ? { ...chat, title: titleFrom(text) } : chat;
  return ask(model, titled, text.trim());
};

export const chatReplied = (model: Model, chatId: string, text: string): Model => {
  const chat = model.chats[chatId];
  if (!chat) return model;
  return setChat(model, { ...chat, messages: [...chat.messages, message(chat, "assistant", text, model.now)], pending: false });
};

export const chatFailed = (model: Model, chatId: string, error: string): Model => {
  const chat = model.chats[chatId];
  return chat ? setChat(model, { ...chat, pending: false, error }) : model;
};

/** A reply in flight when the Controller died is lost; say so instead of spinning forever. */
export const failInterruptedChats = (model: Model): Model =>
  Object.values(model.chats)
    .filter((c) => c.pending)
    .reduce((m, c) => chatFailed(m, c.id, "The Controller restarted before the reply arrived. Send again."), model);
