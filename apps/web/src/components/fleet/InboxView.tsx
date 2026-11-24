import { useState, type FormEvent } from "react";
import { AlarmClock, Check, CheckCheck, Inbox, MessageSquare, RotateCcw, SendHorizontal } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAppToast } from "../AppToast.js";
import type { FleetModel, FleetTask } from "./fleet-types.js";
import type { FleetSend } from "./FleetModule.js";
import { FleetDialog } from "./GuideCard.js";
import { agentName, ago, artifactsNewestFirst, inboxOf, runTitle, taskAgentKey, taskTone } from "./fleet-view-model.js";

const STACK_DEPTH = 2;

export function InboxView({
  model,
  send,
  onOpenChat,
}: {
  model: FleetModel;
  send: FleetSend;
  onOpenChat: (chatId: string) => void;
}) {
  const notify = useAppToast();
  const items = inboxOf(model);
  const top = items[0];

  const ackAll = async () => {
    try {
      await send("AckAllInbox", {});
    } catch (e) {
      notify({ title: "Couldn't clear the inbox", description: e instanceof Error ? e.message : undefined, tone: "error" });
    }
  };

  if (!top) {
    return (
      <div className="fleet-inbox-empty">
        <Inbox size={40} strokeWidth={1} />
        <p className="fleet-inbox-empty-title">All caught up</p>
        <p className="fleet-muted">When an agent finishes a run, its result shows up here.</p>
      </div>
    );
  }

  return (
    <div className="fleet-inbox">
      <div className="fleet-inbox-bar">
        <span className="fleet-muted">
          {items.length === 1 ? "1 result to review" : `${items.length} results to review`}
        </span>
        {items.length > 1 && (
          <button type="button" className="btn-secondary fleet-small-btn" onClick={() => void ackAll()}>
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>
      <div className="fleet-stack" style={{ ["--fleet-stack-depth" as string]: Math.min(items.length - 1, STACK_DEPTH) }}>
        {items.slice(1, 1 + STACK_DEPTH).map((t, i) => (
          <div key={t.id} className="fleet-stack-shadow" style={{ ["--fleet-stack-i" as string]: i + 1 }} aria-hidden="true" />
        ))}
        <InboxCard key={top.id} model={model} task={top} send={send} onOpenChat={onOpenChat} />
      </div>
    </div>
  );
}

/** Run again and Continue in chat, shared by the Inbox card and a past run's dialog. */
const useRunActions = (model: FleetModel, task: FleetTask, send: FleetSend, onOpenChat: (chatId: string) => void) => {
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

  return { busy, act, continueInChat, runAgain };
};

function RunMeta({ model, task }: { model: FleetModel; task: FleetTask }) {
  return (
    <>
      {task.trigger === "schedule" && (
        <span className="fleet-inbox-scheduled">
          <AlarmClock size={12} aria-hidden="true" /> scheduled
        </span>
      )}
      <span className={`fleet-state fleet-tone-${taskTone(task.state)}`}>{task.state}</span>
      <span className="fleet-muted">· {ago(model.now, task.updatedAt)}</span>
    </>
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

export function InboxCard({
  model,
  task,
  send,
  onOpenChat,
}: {
  model: FleetModel;
  task: FleetTask;
  send: FleetSend;
  onOpenChat: (chatId: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const { busy, act, continueInChat, runAgain } = useRunActions(model, task, send, onOpenChat);
  const failed = taskTone(task.state) === "bad";

  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (question.trim()) void continueInChat(question.trim());
  };

  return (
    <article className={`fleet-inbox-card${failed ? " failed" : ""}`} aria-label={runTitle(model, task)}>
      <header className="fleet-inbox-card-head">
        <span className="fleet-inbox-agent">{agentName(model, task)}</span>
        <span className="fleet-muted">on {task.runner}</span>
        <RunMeta model={model} task={task} />
      </header>
      <h2 className="fleet-inbox-title">{runTitle(model, task)}</h2>

      <RunResult task={task} />

      <form className="fleet-inbox-ask" onSubmit={ask}>
        <input
          className="field-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a follow-up about this result…"
          aria-label="Ask a follow-up"
          disabled={busy}
        />
        <button type="submit" className="btn-secondary fleet-icon-btn" disabled={busy || !question.trim()} aria-label="Ask in chat">
          <SendHorizontal size={15} />
        </button>
      </form>

      <footer className="fleet-inbox-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void runAgain()}>
          <RotateCcw size={14} /> Run again
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void continueInChat("")}>
          <MessageSquare size={14} /> Continue in chat
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void act("mark it read", () => send("AckInbox", { taskId: task.id }))}
          autoFocus
        >
          <Check size={15} /> Ok, got it
        </button>
      </footer>
    </article>
  );
}

/** A finished run opened from an agent's history, read or not. */
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
  onOpenChat: (chatId: string) => void;
  onClose: () => void;
}) {
  const { busy, continueInChat, runAgain } = useRunActions(model, task, send, onOpenChat);
  return (
    <FleetDialog title={runTitle(model, task)} onClose={onClose}>
      <p className="fleet-inbox-card-head fleet-run-meta">
        <span className="fleet-muted">{agentName(model, task)} on {task.runner}</span>
        <RunMeta model={model} task={task} />
      </p>
      <RunResult task={task} />
      <div className="fleet-guide-actions">
        <span className="fleet-agent-links-spacer" />
        <button type="button" className="btn-secondary fleet-small-btn" disabled={busy} onClick={() => void continueInChat("")}>
          <MessageSquare size={13} /> Continue in chat
        </button>
        <button
          type="button"
          className="btn-primary fleet-small-btn"
          disabled={busy}
          onClick={() => void runAgain().then((ok) => ok && onClose())}
        >
          <RotateCcw size={13} /> Run again
        </button>
      </div>
    </FleetDialog>
  );
}
