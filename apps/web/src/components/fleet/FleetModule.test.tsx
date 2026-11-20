import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { FleetConnectForm, FleetLinkBadge, FleetModule } from "./FleetModule.js";
import { InboxCard, InboxView } from "./InboxView.js";
import { ChatPane } from "./ChatsView.js";
import { AgentCard, AgentsView } from "./AgentsView.js";
import type { FleetChat, FleetModel, FleetTask } from "./fleet-types.js";

const NOW = 1_000_000;

const jokes: FleetTask = {
  id: "t1",
  runner: "ec2",
  agent: "dadjokes",
  prompt: "coffee",
  state: "completed",
  statusText: "jokes delivered",
  artifacts: [{ id: "jokes", name: "jokes", text: "It got mugged." }],
  createdAt: NOW - 60_000,
  updatedAt: NOW - 57_000,
  ackedAt: null,
};

const chat: FleetChat = {
  id: "c1",
  title: "hello",
  context: null,
  messages: [
    { id: "c1:0", role: "user", text: "hello there", at: NOW - 5_000 },
    { id: "c1:1", role: "assistant", text: "General Kenobi", at: NOW - 4_000 },
  ],
  pending: false,
  error: null,
  createdAt: NOW - 5_000,
  updatedAt: NOW - 4_000,
};

const model: FleetModel = {
  now: NOW,
  runners: {
    ec2: {
      name: "ec2",
      url: "http://127.0.0.1:9471",
      status: "healthy",
      failures: 0,
      nextCheckAt: NOW + 15_000,
      lastSeenAt: NOW - 3_000,
      lastError: null,
      location: "EC2 us-west-2",
    },
  },
  agents: {
    "ec2/dadjokes": {
      key: "ec2/dadjokes",
      runner: "ec2",
      id: "dadjokes",
      name: "Dad jokes",
      description: "Writes dad jokes.",
      input: { label: "Topic", hint: "what the jokes are about", example: "penguins" },
      schedule: null,
    },
  },
  tasks: { t1: jokes },
  chats: { c1: chat },
  notifications: [],
};

const noop = async () => null;
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<AppToastProvider>{node}</AppToastProvider>);

describe("FleetModule", () => {
  it("shows the unread count on the Inbox tab", () => {
    const html = wrap(<FleetModule model={model} link={{ kind: "live" }} send={noop} onEditConnection={() => {}} />);
    expect(html).toContain("Inbox (1)");
  });

  it("waits for the Controller before showing any view", () => {
    const html = wrap(<FleetModule model={null} link={{ kind: "connecting" }} send={noop} onEditConnection={() => {}} />);
    expect(html).toContain("Waiting for the Controller");
  });
});

describe("InboxView", () => {
  it("says all caught up when nothing is unread", () => {
    const read = { ...model, tasks: { t1: { ...jokes, ackedAt: NOW } } };
    expect(wrap(<InboxView model={read} send={noop} onOpenChat={() => {}} />)).toContain("All caught up");
  });

  it("leaves running tasks out of the inbox", () => {
    const busy = { ...model, tasks: { t1: { ...jokes, state: "working" as const } } };
    expect(wrap(<InboxView model={busy} send={noop} onOpenChat={() => {}} />)).toContain("All caught up");
  });

  it("offers mark-all-read only when there is more than one result", () => {
    const two = { ...model, tasks: { t1: jokes, t2: { ...jokes, id: "t2" } } };
    expect([
      wrap(<InboxView model={model} send={noop} onOpenChat={() => {}} />).includes("Mark all read"),
      wrap(<InboxView model={two} send={noop} onOpenChat={() => {}} />).includes("Mark all read"),
    ]).toEqual([false, true]);
  });
});

describe("InboxCard", () => {
  const card = (task: FleetTask) => wrap(<InboxCard model={model} task={task} send={noop} onOpenChat={() => {}} />);

  it("names the agent and its runner", () => {
    const html = card(jokes);
    expect([html.includes("Dad jokes"), html.includes("on ec2")]).toEqual([true, true]);
  });

  it("titles the card with the agent's input label and the prompt", () => {
    expect(card(jokes)).toContain("Topic: coffee");
  });

  it("shows the result", () => {
    expect(card(jokes)).toContain("It got mugged.");
  });

  it("offers the acknowledge and continue-in-chat actions", () => {
    const html = card(jokes);
    expect([html.includes("Ok, got it"), html.includes("Continue in chat")]).toEqual([true, true]);
  });

  it("explains why a run failed", () => {
    expect(card({ ...jokes, state: "failed", statusText: "bedrock: throttled", artifacts: [] })).toContain("bedrock: throttled");
  });

  it("keeps secondary outputs collapsed", () => {
    const report = {
      ...jokes,
      artifacts: [
        { id: "metrics", name: "metrics", text: "load 4.5" },
        { id: "summary", name: "summary", text: "All good" },
      ],
    };
    expect(card(report)).toMatch(/<details[^>]*><summary>metrics<\/summary>/);
  });
});

describe("ChatPane", () => {
  it("renders both sides of the conversation", () => {
    const html = wrap(<ChatPane chat={chat} send={noop} onCreated={() => {}} />);
    expect([html.includes("hello there"), html.includes("General Kenobi")]).toEqual([true, true]);
  });

  it("shows a typing indicator while a reply is pending", () => {
    expect(wrap(<ChatPane chat={{ ...chat, pending: true }} send={noop} onCreated={() => {}} />)).toContain("Assistant is replying");
  });

  it("shows why a reply failed", () => {
    expect(wrap(<ChatPane chat={{ ...chat, error: "throttled" }} send={noop} onCreated={() => {}} />)).toContain("throttled");
  });

  it("invites a first message for a new chat", () => {
    expect(wrap(<ChatPane chat={undefined} send={noop} onCreated={() => {}} />)).toContain("Start a conversation");
  });
});

describe("AgentsView", () => {
  const view = (m: FleetModel) => wrap(<AgentsView model={m} send={noop} />);

  it("groups agents under their runner with its location", () => {
    const html = view(model);
    expect([html.includes("Runner ec2"), html.includes("EC2 us-west-2"), html.includes("Dad jokes")]).toEqual([true, true, true]);
  });

  it("marks agents of an unreachable runner", () => {
    const down = { ...model, runners: { ec2: { ...model.runners.ec2!, status: "unreachable" as const } } };
    expect(view(down)).toContain("UNREACHABLE");
  });

  it("says so when a runner serves no agents", () => {
    expect(view({ ...model, agents: {} })).toContain("This runner serves no agents.");
  });
});

describe("AgentCard", () => {
  const card = (m: FleetModel) =>
    wrap(<AgentCard model={m} agent={m.agents["ec2/dadjokes"]!} runner={m.runners.ec2!} send={noop} />);

  it("shows the agent's key", () => {
    expect(card(model)).toContain("ec2/dadjokes");
  });

  it("draws one history cell per run", () => {
    const three = { ...model, tasks: { a: { ...jokes, id: "a" }, b: { ...jokes, id: "b", state: "failed" as const }, c: { ...jokes, id: "c" } } };
    expect(card(three).match(/fleet-strip-cell/g)?.length).toBe(3);
  });

  it("shows evals as not available yet", () => {
    expect(card(model)).toMatch(/<button[^>]*disabled=""[^>]*>\[evals\]/);
  });

  it("shows the daily schedule", () => {
    const scheduled = { ...model, agents: { "ec2/dadjokes": { ...model.agents["ec2/dadjokes"]!, schedule: { at: "07:30", prompt: "" } } } };
    expect(card(scheduled)).toContain("Daily at 07:30");
  });

  it("says when an agent isn't scheduled", () => {
    expect(card(model)).toContain("Not scheduled");
  });
});

describe("InboxCard trigger", () => {
  it("marks runs started by the schedule", () => {
    const html = wrap(<InboxCard model={model} task={{ ...jokes, trigger: "schedule" }} send={noop} onOpenChat={() => {}} />);
    expect(html).toContain("scheduled");
  });
});

describe("FleetLinkBadge", () => {
  it.each([
    [{ kind: "live" } as const, "Live"],
    [{ kind: "retrying", error: "down" } as const, "Reconnecting…"],
    [{ kind: "rejected", error: "bad token" } as const, "Not connected"],
  ])("renders %o as %s", (link, text) => {
    expect(renderToStaticMarkup(<FleetLinkBadge link={link} />)).toContain(text);
  });
});

describe("FleetConnectForm", () => {
  it("shows the Controller's rejection reason", () => {
    const html = renderToStaticMarkup(
      <FleetConnectForm initial={null} error="The Controller rejected the token." onConnect={() => {}} />,
    );
    expect(html).toContain("The Controller rejected the token.");
  });
});
