import { useState, type FormEvent, type KeyboardEvent } from "react";
import { MessageCircle, Plus, SendHorizontal, Sparkles } from "lucide-react";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { useAppToast } from "../AppToast.js";
import type { FleetChat, FleetModel } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { ago, chatsOf } from "./fleet-view-model.js";

export function ChatsView({
  model,
  send,
  selectedId,
  onSelect,
}: {
  model: FleetModel;
  send: FleetSend;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const chats = chatsOf(model);
  const selected = selectedId ? model.chats?.[selectedId] : undefined;

  return (
    <div className="fleet-chats">
      <aside className="fleet-chat-list" aria-label="Chats">
        <button type="button" className="btn-primary fleet-new-chat" onClick={() => onSelect(null)}>
          <Plus size={15} /> New chat
        </button>
        {chats.length === 0 ? (
          <p className="fleet-muted fleet-chat-list-empty">No chats yet.</p>
        ) : (
          <ul>
            {chats.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`fleet-chat-row${c.id === selectedId ? " active" : ""}`}
                  onClick={() => onSelect(c.id)}
                  aria-current={c.id === selectedId}
                >
                  <span className="fleet-chat-row-title">{c.title}</span>
                  <span className="fleet-chat-row-sub">
                    {c.context && <span className="fleet-chat-badge">from run</span>}
                    {c.pending ? "replying…" : ago(model.now, c.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <ChatPane key={selected?.id ?? "new"} chat={selected} send={send} onCreated={onSelect} />
    </div>
  );
}

export function ChatPane({
  chat,
  send,
  onCreated,
}: {
  chat: FleetChat | undefined;
  send: FleetSend;
  onCreated: (id: string) => void;
}) {
  const notify = useAppToast();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const blocked = sending || chat?.pending === true;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || blocked) return;
    setSending(true);
    try {
      if (chat) {
        await send("SendChatMessage", { chatId: chat.id, text });
      } else {
        const id = await send("CreateChat", { text });
        if (id) onCreated(id);
      }
      setDraft("");
    } catch (e) {
      notify({ title: "Couldn't send the message", description: e instanceof Error ? e.message : undefined, tone: "error" });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="fleet-chat-pane" aria-label={chat?.title ?? "New chat"}>
      <Conversation className="fleet-chat-scroll">
        <ConversationContent className="fleet-chat-content">
          {chat?.context && (
            <details className="fleet-chat-context">
              <summary>
                <Sparkles size={13} /> Started from an agent result
              </summary>
              <pre className="fleet-artifact-text">{chat.context.text}</pre>
            </details>
          )}
          {!chat || chat.messages.length === 0 ? (
            <div className="fleet-chat-empty">
              <MessageCircle size={40} strokeWidth={1} />
              <p>{chat?.context ? "Ask anything about this result." : "Start a conversation with the fleet assistant."}</p>
            </div>
          ) : (
            chat.messages.map((m) => (
              <Message from={m.role} key={m.id}>
                <MessageContent className={m.role === "assistant" ? "fleet-bubble-assistant" : undefined}>
                  {m.role === "assistant" ? <MessageResponse>{m.text}</MessageResponse> : <span className="fleet-user-text">{m.text}</span>}
                </MessageContent>
              </Message>
            ))
          )}
          {chat?.pending && (
            <Message from="assistant">
              <MessageContent className="fleet-bubble-assistant fleet-typing" aria-label="Assistant is replying">
                <span />
                <span />
                <span />
              </MessageContent>
            </Message>
          )}
          {chat?.error && !chat.pending && (
            <p className="fleet-chat-error" role="alert">
              Couldn't get a reply: {chat.error}
            </p>
          )}
        </ConversationContent>
      </Conversation>
      <form className="fleet-composer" onSubmit={(e) => void submit(e)}>
        <textarea
          className="field-input"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={chat?.pending ? "Waiting for the reply…" : "Message the assistant (Enter to send, Shift+Enter for a new line)"}
          aria-label="Message"
          autoFocus
        />
        <button type="submit" className="btn-primary" disabled={blocked || !draft.trim()}>
          <SendHorizontal size={15} /> Send
        </button>
      </form>
    </section>
  );
}
