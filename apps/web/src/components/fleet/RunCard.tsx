import { useState, type FormEvent } from "react";
import { AlarmClock, Bot, Check, CornerDownRight, MessageSquare, RotateCcw, SendHorizontal } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAppToast } from "../AppToast.js";
import type { FleetModel, FleetTask } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { FleetDialog } from "./GuideCard.js";
import { agentName, ago, artifactsNewestFirst, canFollowUp, earlierRuns, runTitle, taskAgentKey, taskTone } from "./fleet-view-model.js";

export type OpenChat = (chatId: string) => void;

/** Run again, Continue in chat, Follow up and Ok, got it, shared by every place a result is shown. */
export const useRunActions = (model: FleetModel, task: FleetTask, send: FleetSend, onOpenChat: OpenChat) => {
  const notify = useAppToast();
  const [busy, setBusy] = useState(false);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (e) {
      notify({ title: `Couldn't ${label}`, description: e instanceof Error ? e.message : undefined, tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const continueInChat = (text: string) =>
    act("start the chat", async () => {
      const chatId = await send("CreateChat", { fromTaskId: task.id, text });
      if (chatId) onOpenChat(chatId);
    });

  const runAgain = () =>
    act("run it again", async () => {
      await send("CreateTask", { agent: taskAgentKey(task), prompt: task.prompt });
      notify({ title: `Started ${agentName(model, task)} again`, tone: "success" });
    });

  const ack = () => act("mark it read", () => send("AckInbox", { taskId: task.id }));

  /** Answering a result is dealing with it, so the run it answers leaves the inbox. */
  const followUp = (text: string) =>
    act("send the follow-up", async () => {
      await send("CreateTask", { followUpOf: task.id, prompt: text });
      if (task.ackedAt == null) await send("AckInbox", { taskId: task.id });
      notify({ title: `Asked ${agentName(model, task)}`, description: "The answer lands in your inbox.", tone: "success" });
    });

  return { busy, continueInChat, runAgain, ack, followUp };
};

export function RunMeta({ model, task }: { model: FleetModel; task: FleetTask }) {
  return (
    <>
      {task.trigger === "schedule" && (
        <span className="fleet-inbox-scheduled">
          <AlarmClock size={12} aria-hidden="true" /> scheduled
        </span>
      )}
      {task.followUpOf && (
        <span className="fleet-inbox-scheduled">
          <CornerDownRight size={12} aria-hidden="true" /> follow-up
        </span>
      )}
      <span className={`fleet-state fleet-tone-${taskTone(task.state)}`}>{task.state}</span>
      <span className="fleet-muted">· {ago(model.now, task.updatedAt)}</span>
    </>
  );
}

/** What a follow-up continues: each earlier question and the agent's answer. */
export function EarlierRuns({ model, task }: { model: FleetModel; task: FleetTask }) {
  const earlier = earlierRuns(model, task);
  if (earlier.length === 0) return null;
  return (
    <details className="fleet-inbox-extra fleet-earlier">
      <summary>Earlier in this conversation ({earlier.length})</summary>
      <ol className="fleet-earlier-list">
        {earlier.map((t) => (
          <li key={t.id}>
            <p className="fleet-earlier-prompt">{t.prompt || "(no input)"}</p>
            {artifactsNewestFirst(t)[0] ? (
              <div className="fleet-inbox-result">
                <MessageResponse>{artifactsNewestFirst(t)[0]!.text}</MessageResponse>
              </div>
            ) : (
              <p className="fleet-muted">{t.statusText ?? t.state}</p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function RunResult({ task }: { task: FleetTask }) {
  const [primary, ...others] = artifactsNewestFirst(task);
  const failed = taskTone(task.state) === "bad";
  return (
    <div className="fleet-inbox-body">
      {failed && task.statusText && <p className="fleet-inbox-error">{task.statusText}</p>}
      {primary ? (
        <div className="fleet-inbox-result">
          <MessageResponse>{primary.text}</MessageResponse>
        </div>
      ) : (
        !failed && <p className="fleet-muted">This run produced no output.</p>
      )}
      {others.map((a) => (
        <details key={a.id} className="fleet-inbox-extra">
          <summary>{a.name || a.id}</summary>
          <pre className="fleet-artifact-text">{a.text}</pre>
        </details>
      ))}
    </div>
  );
}

/**
 * `stack`: the one card in front, which takes focus. `detail`: the right pane of the list layout.
 * `compact`: one of many (feed, grouped), without the follow-up box.
 */
export type InboxCardVariant = "stack" | "detail" | "compact";

export function InboxCard({
  model,
  task,
  send,
  onOpenChat,
  variant = "stack",
}: {
  model: FleetModel;
  task: FleetTask;
  send: FleetSend;
  onOpenChat: OpenChat;
  variant?: InboxCardVariant;
}) {
  const [question, setQuestion] = useState("");
  const { busy, continueInChat, runAgain, ack, followUp } = useRunActions(model, task, send, onOpenChat);
  const failed = taskTone(task.state) === "bad";
  const read = task.ackedAt != null;
  const small = variant === "compact";
  const toAgent = canFollowUp(model, task);

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    void (toAgent ? followUp(text) : continueInChat(text)).then((ok) => ok && setQuestion(""));
  };

  return (
    <article
      className={`fleet-inbox-card ${variant}${failed ? " failed" : ""}${read ? " read" : ""}`}
      aria-label={runTitle(model, task)}
    >
      <header className="fleet-inbox-card-head">
        <span className="fleet-inbox-agent">{agentName(model, task)}</span>
        <span className="fleet-muted">on {task.runner}</span>
        <RunMeta model={model} task={task} />
        {read && <span className="fleet-muted">· read</span>}
      </header>
      <h2 className="fleet-inbox-title">{runTitle(model, task)}</h2>

      <EarlierRuns model={model} task={task} />
      <RunResult task={task} />

      {!small && (
        <form className="fleet-inbox-ask" onSubmit={ask}>
          <span
            className={`fleet-inbox-ask-to${toAgent ? " agent" : ""}`}
            title={
              toAgent
                ? `${agentName(model, task)} gets your message and remembers this conversation`
                : `${agentName(model, task)} doesn't keep conversations, so this opens a chat about the result`
            }
          >
            {toAgent ? <Bot size={13} aria-hidden="true" /> : <MessageSquare size={13} aria-hidden="true" />}
            {toAgent ? agentName(model, task) : "Chat"}
          </span>
          <input
            className="field-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={toAgent ? `Reply to ${agentName(model, task)}…` : "Ask about this result in a chat…"}
            aria-label="Ask a follow-up"
            disabled={busy}
          />
          <button
            type="submit"
            className="btn-secondary fleet-icon-btn"
            disabled={busy || !question.trim()}
            aria-label={toAgent ? `Send to ${agentName(model, task)}` : "Ask in chat"}
          >
            <SendHorizontal size={15} />
          </button>
        </form>
      )}

      <footer className="fleet-inbox-actions">
        <button type="button" className={`btn-secondary${small ? " fleet-small-btn" : ""}`} disabled={busy} onClick={() => void runAgain()}>
          <RotateCcw size={small ? 13 : 14} /> Run again
        </button>
        <button type="button" className={`btn-secondary${small ? " fleet-small-btn" : ""}`} disabled={busy} onClick={() => void continueInChat("")}>
          <MessageSquare size={small ? 13 : 14} /> Continue in chat
        </button>
        {!read && (
          <button
            type="button"
            className={`btn-primary${small ? " fleet-small-btn" : ""}`}
            disabled={busy}
            onClick={() => void ack()}
            autoFocus={variant === "stack"}
          >
            <Check size={small ? 13 : 15} /> Ok, got it
          </button>
        )}
      </footer>
    </article>
  );
}

/** One finished run in a dialog, opened from a list of runs; unread ones can be marked read here. */
export function RunDialog({
  model,
  task,
  send,
  onOpenChat,
  onClose,
}: {
  model: FleetModel;
  task: FleetTask;
  send: FleetSend;
  onOpenChat: OpenChat;
  onClose: () => void;
}) {
  const { busy, continueInChat, runAgain, ack } = useRunActions(model, task, send, onOpenChat);
  const closeAfter = (action: () => Promise<boolean>) => () => void action().then((ok) => ok && onClose());
  return (
    <FleetDialog title={runTitle(model, task)} onClose={onClose}>
      <p className="fleet-inbox-card-head fleet-run-meta">
        <span className="fleet-muted">
          {agentName(model, task)} on {task.runner}
        </span>
        <RunMeta model={model} task={task} />
      </p>
      <EarlierRuns model={model} task={task} />
      <RunResult task={task} />
      <div className="fleet-guide-actions">
        <span className="fleet-agent-links-spacer" />
        <button type="button" className="btn-secondary fleet-small-btn" disabled={busy} onClick={() => void continueInChat("")}>
          <MessageSquare size={13} /> Continue in chat
        </button>
        <button type="button" className={`${task.ackedAt == null ? "btn-secondary" : "btn-primary"} fleet-small-btn`} disabled={busy} onClick={closeAfter(runAgain)}>
          <RotateCcw size={13} /> Run again
        </button>
        {task.ackedAt == null && (
          <button type="button" className="btn-primary fleet-small-btn" disabled={busy} onClick={closeAfter(ack)}>
            <Check size={13} /> Ok, got it
          </button>
        )}
      </div>
    </FleetDialog>
  );
}
