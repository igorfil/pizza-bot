import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { FleetConnectForm, FleetLinkBadge, FleetModule } from "./FleetModule.js";
import { InboxView, type InboxLayout } from "./InboxView.js";
import { InboxCard } from "./RunCard.js";
import { ChatPane } from "./ChatsView.js";
import { AgentsView, type AgentsLayout } from "./AgentsView.js";
import { AgentCard } from "./AgentsLayouts.js";
import { InlineRuns } from "./AgentParts.js";
import { addablePlugins, addAgentModes } from "./AddAgentDialog.js";
import { GuideCard, GuidePicker } from "./GuideCard.js";
import type { FleetChat, FleetGuideSession, FleetModel, FleetTask } from "./fleet-types.js";

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
      transport: "direct",
      origin: null,
      link: { state: "up", url: "http://127.0.0.1:9471" },
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

describe("Inbox layouts", () => {
  const two = { ...model, tasks: { t1: jokes, t2: { ...jokes, id: "t2", prompt: "tea", updatedAt: NOW - 30_000 } } };
  const view = (layout: InboxLayout, m: FleetModel = two) => wrap(<InboxView model={m} send={noop} onOpenChat={() => {}} initialLayout={layout} />);

  it("offers every layout, with the current one pressed", () => {
    const html = view("feed");
    expect([html.match(/aria-pressed="(true|false)"/g)?.length, /aria-pressed="true"[^>]*title="Every result in full/.test(html)]).toEqual([6, true]);
  });

  it("overview: a page thumbnail per result, each opening it, with a size control", () => {
    const html = view("overview");
    expect([html.match(/class="fleet-thumb-open"/g)?.length, html.includes(", completed, unread"), html.includes('aria-label="Thumbnail size"')]).toEqual([2, true, true]);
  });

  it("overview: previews are hidden from assistive tech and can't take focus", () => {
    expect(view("overview")).toMatch(/class="fleet-thumb-page" aria-hidden="true" inert=""/);
  });

  it("keeps the switcher when there is nothing to review", () => {
    const read = { ...model, tasks: { t1: { ...jokes, ackedAt: NOW } } };
    const html = view("table", read);
    expect([html.includes("All caught up"), html.includes('aria-label="Inbox layout"')]).toEqual([true, true]);
  });

  it("list: one option per result, the newest selected and shown", () => {
    const html = view("list");
    expect([html.match(/role="option"/g)?.length, /aria-selected="true"[^>]*>.*Topic: tea/.test(html)]).toEqual([2, true]);
  });

  it("feed: results under a day heading, each in full", () => {
    const html = view("feed");
    expect([html.includes(">Today<"), html.match(/It got mugged\./g)?.length]).toEqual([true, 2]);
  });

  it("by agent: one group with its count, the newest open and the rest as rows", () => {
    const html = view("agents");
    expect([html.includes('aria-label="Older results from Dad jokes"'), html.match(/It got mugged\./g)?.length]).toEqual([true, 1]);
  });

  it("table: a row per result and bulk actions that wait for a selection", () => {
    const html = view("table");
    expect([html.match(/aria-label="Select Topic:/g)?.length, /<button[^>]*disabled=""[^>]*>.*?Mark read/.test(html)]).toEqual([2, true]);
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
  const view = (m: FleetModel) => wrap(<AgentsView model={m} send={noop} onOpenChat={() => {}} />);

  it("groups agents under their runner with its location", () => {
    const html = view(model);
    expect([html.includes("Runner ec2"), html.includes("EC2 us-west-2"), html.includes("Dad jokes")]).toEqual([true, true, true]);
  });

  it("marks agents of an unreachable runner", () => {
    const down = { ...model, runners: { ec2: { ...model.runners.ec2!, status: "unreachable" as const } } };
    expect(view(down)).toContain("Runner unreachable");
  });

  it("invites adding the first agent when a runner serves none", () => {
    expect(view({ ...model, agents: {} })).toContain("No agents yet. Add one to choose what ec2 runs.");
  });

  it("offers adding an agent in every runner's heading", () => {
    expect(view(model)).toContain('aria-label="Add agent to ec2"');
  });

  it("offers Add runner in the page header and Add agent on every runner", () => {
    const html = view(model);
    expect([html.match(/>\s*Add runner/g)?.length, html.match(/>\s*Add agent/g)?.length]).toEqual([1, 1]);
  });

  it("offers no remove button for a runner on this machine", () => {
    const local = { ...model, runners: { ec2: { ...model.runners.ec2!, local: true } } };
    expect([view(model).includes('aria-label="Remove runner ec2"'), view(local).includes('aria-label="Remove runner ec2"')]).toEqual([true, false]);
  });

  it("says how many agents run on how many runners", () => {
    expect(view(model)).toContain("1 agent on 1 runner");
  });

  it("shows a renamed runner by its display name", () => {
    const renamed = { ...model, runners: { ec2: { ...model.runners.ec2!, label: "Build box" } } };
    expect([view(renamed).includes('aria-label="Runner Build box"'), view(renamed).includes('aria-label="Runner ec2"')]).toEqual([true, false]);
  });

  it("names the runner's state in words next to its dot", () => {
    expect(view(model)).toMatch(/online · seen/);
  });

  it("shows agents being added to a runner", () => {
    const ec2 = { ...model.runners.ec2!, agentsChange: { action: "add" as const, agents: ["Slow"], error: null } };
    expect(view({ ...model, runners: { ec2 } })).toContain("Adding Slow…");
  });

  it("explains why removing an agent failed", () => {
    const ec2 = { ...model.runners.ec2!, agentsChange: { action: "remove" as const, agents: ["Dad jokes"], error: "HTTP 500" } };
    expect(view({ ...model, runners: { ec2 } })).toContain("Couldn&#x27;t remove Dad jokes: HTTP 500");
  });

  it("explains why adding agents failed", () => {
    const ec2 = { ...model.runners.ec2!, agentsChange: { action: "add" as const, agents: ["slow"], error: "HTTP 500" } };
    expect(view({ ...model, runners: { ec2 } })).toContain("Couldn&#x27;t add slow: HTTP 500");
  });
});

describe("Agents layouts", () => {
  const two = { ...model, agents: { ...model.agents, "ec2/fact": { ...model.agents["ec2/dadjokes"]!, key: "ec2/fact", id: "fact", name: "Geography fact" } } };
  const view = (layout: AgentsLayout, m: FleetModel = two) => wrap(<AgentsView model={m} send={noop} onOpenChat={() => {}} initialLayout={layout} />);

  it("offers every layout, with the current one pressed", () => {
    const html = view("table");
    expect([html.match(/aria-pressed="(true|false)"/g)?.length, /aria-pressed="true"[^>]*title="One row per agent"/.test(html)]).toEqual([3, true]);
  });

  it("cards: a card per agent", () => {
    expect(view("cards").match(/<article class="fleet-agent-card/g)?.length).toBe(2);
  });

  it("list: a row per agent, the first selected and shown in full", () => {
    const html = view("list");
    expect([html.match(/class="fleet-inbox-row fleet-agents-row/g)?.length, /aria-current="true"[^>]*>.*?Dad jokes/.test(html), html.includes('aria-label="Runs of Dad jokes"')]).toEqual([
      2,
      true,
      true,
    ]);
  });

  it("table: a row per agent under its runner, each opening the agent", () => {
    const html = view("table");
    expect([html.includes('aria-label="Runner ec2"'), html.match(/aria-label="Open (Dad jokes|Geography fact)"/g)?.length]).toEqual([true, 2]);
  });
});

describe("Add agent", () => {
  const runner = model.runners.ec2!;
  const offer = (over: Partial<typeof runner>) => addAgentModes({ ...runner, ...over });

  it("offers creating a new agent on a runner with the built-in engine", () => {
    expect(offer({ canCreateAgents: true })).toEqual({ modes: ["create"] });
  });

  const docker = { id: "docker", name: "Docker", version: "1", capabilities: ["cancel", "add"], healthy: false, detail: "spawn docker ENOENT", addFields: [{ id: "name", label: "Name", kind: "text" as const }] };

  it("offers adding an existing agent when a plugin can add agents, even an unusable one", () => {
    expect(offer({ canCreateAgents: true, plugins: [docker] })).toEqual({ modes: ["create", "existing"] });
  });

  it("offers only adding existing agents on a runner without the engine", () => {
    expect(offer({ canCreateAgents: false, plugins: [{ ...docker, healthy: true }] })).toEqual({ modes: ["existing"] });
  });

  it("doesn't count a plugin that can't add agents", () => {
    expect(addablePlugins({ ...runner, plugins: [{ ...docker, capabilities: ["cancel"] }, { ...docker, id: "old", addFields: undefined }] })).toEqual([]);
  });

  it("explains that a runner without the built-in engine can't run new agents", () => {
    const r = offer({ canCreateAgents: false });
    expect("blocker" in r && r.blocker).toContain("no built-in engine");
  });

  it("waits for an unreachable runner", () => {
    const r = offer({ status: "unreachable", canCreateAgents: true });
    expect("blocker" in r && r.blocker).toContain("isn't reachable");
  });
});

describe("AgentCard", () => {
  const card = (m: FleetModel) => wrap(<AgentCard model={m} agent={m.agents["ec2/dadjokes"]!} runner={m.runners.ec2!} send={noop} onOpen={() => {}} />);

  it("opens the agent's details from its name", () => {
    expect(card(model)).toContain('aria-label="Open Dad jokes"');
  });

  it("can't be run again while it runs", () => {
    const running = { ...model, tasks: { a: { ...jokes, id: "a", state: "working" as const } } };
    expect(card(running)).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Run Dad jokes"/);
  });

  it("shows that it's being removed, without a Run button", () => {
    const ec2 = { ...model.runners.ec2!, agentsChange: { action: "remove" as const, agents: ["Dad jokes"], error: null } };
    const html = card({ ...model, runners: { ec2 } });
    expect([html.includes("Removing…"), html.includes('aria-label="Run Dad jokes"')]).toEqual([true, false]);
  });

  it("shows what the agent runs with", () => {
    const created = { ...model, agentModels: [{ id: "m", label: "Claude Haiku" }], agents: { "ec2/dadjokes": { ...model.agents["ec2/dadjokes"]!, model: "m" } } };
    expect(card(created)).toContain("Claude Haiku");
  });

  it("keeps the agent's key out of the card text", () => {
    expect(card(model)).not.toContain(">ec2/dadjokes<");
  });

  it("draws one history cell per run", () => {
    const three = { ...model, tasks: { a: { ...jokes, id: "a" }, b: { ...jokes, id: "b", state: "failed" as const }, c: { ...jokes, id: "c" } } };
    expect(card(three).match(/fleet-strip-cell/g)?.length).toBe(3);
  });

  it("describes the run history in words", () => {
    const two = { ...model, tasks: { a: { ...jokes, id: "a" }, b: { ...jokes, id: "b", state: "failed" as const } } };
    expect(card(two)).toContain('aria-label="Last 2 runs: 1 completed, 1 failed"');
  });

  it("shows the daily schedule", () => {
    const scheduled = { ...model, agents: { "ec2/dadjokes": { ...model.agents["ec2/dadjokes"]!, schedule: { at: "07:30", prompt: "" } } } };
    expect(card(scheduled)).toContain("Daily at 07:30");
  });

  it("shows what scheduled runs get as input", () => {
    const scheduled = { ...model, agents: { "ec2/dadjokes": { ...model.agents["ec2/dadjokes"]!, schedule: { at: "07:30", prompt: "otters" } } } };
    expect(card(scheduled)).toContain("Topic: otters");
  });

  it("leaves the schedule out when there is none", () => {
    expect(card(model)).not.toContain("Daily at");
  });
});

describe("InlineRuns", () => {
  const rows = (runs: FleetTask[]) => wrap(<InlineRuns model={model} runs={runs} onOpen={() => {}} />);

  it("lets a finished run be opened, read or not", () => {
    expect(rows([jokes, { ...jokes, id: "t2", ackedAt: NOW }]).match(/<button[^>]*title="Open the result"/g)?.length).toBe(2);
  });

  it("doesn't open a run that is still going", () => {
    expect(rows([{ ...jokes, state: "working" }])).not.toContain("Open the result");
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

describe("runner guides", () => {
  const catalog = [
    { id: "aws", title: "AWS EC2", description: "Put a runner on an EC2 instance." },
    { id: "manual", title: "By URL", description: "A runner you started yourself." },
  ];
  const session = (over: Partial<FleetGuideSession> = {}): FleetGuideSession => ({
    id: "g1",
    guide: "aws",
    status: "ask",
    view: {
      title: "Where should the runner go?",
      body: "Account 123.",
      fields: [
        {
          id: "instance",
          label: "Instance",
          kind: "choice",
          options: [
            { value: "i-off", label: "i-off", detail: "SSM agent not online", disabled: true },
            { value: "i-on", label: "box (i-on)" },
          ],
        },
        { id: "token", label: "Token", kind: "secret" },
      ],
      submit: "Set up runner",
    },
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  const withGuides = (s?: FleetGuideSession): FleetModel => ({ ...model, guideCatalog: catalog, guideSessions: s ? { [s.id]: s } : {} });
  const radio = (html: string, value: string) => html.match(/<input[^>]*type="radio"[^>]*>/g)?.find((i) => i.includes(`value="${value}"`)) ?? "";
  const card = (s: FleetGuideSession) => wrap(<GuideCard session={s} send={noop} />);

  it("shows a coming-soon guide but doesn't let it start", () => {
    const soon = { ...withGuides(), guideCatalog: [{ id: "manual", title: "By URL", description: "", comingSoon: true }] };
    const html = wrap(<GuidePicker model={soon} send={noop} onStarted={() => {}} />);
    expect([html.includes("Coming soon"), /<button[^>]*disabled=""[^>]*>.*By URL/.test(html)]).toEqual([true, true]);
  });

  it("offers every guide the Controller lists", () => {
    const html = wrap(<GuidePicker model={withGuides()} send={noop} onStarted={() => {}} />);
    expect([html.includes("AWS EC2"), html.includes("By URL")]).toEqual([true, true]);
  });

  it("lists a guide in progress on the Agents view with what it waits for", () => {
    expect(wrap(<AgentsView model={withGuides(session())} send={noop} onOpenChat={() => {}} />)).toContain("Waiting for you: Where should the runner go?");
  });

  it("shows where the guide is in its steps", () => {
    const html = card(session({ view: { ...session().view, steps: { labels: ["Sign in", "Pick instance", "Set up"], current: 1 } } }));
    expect(html).toMatch(/<li class="current" aria-current="step">.*Pick instance/);
  });

  it("draws the set-up as a checklist with the current step in progress", () => {
    const checklist = [
      { label: "Connect to the instance", state: "done" as const },
      { label: "Install the runner", state: "current" as const, detail: "Installing… (35s)" },
      { label: "Verify Bedrock access", state: "pending" as const },
    ];
    const html = card(session({ status: "working", view: { title: "Setting up the runner", progress: "Installing… (35s)", fields: [], checklist } }));
    expect([
      /<li class="done">.*Connect to the instance.*\(done\)/.test(html),
      /<li class="current" aria-current="step">.*lucide-loader-circle.*Install the runner.*Installing… \(35s\)/.test(html),
      /<li class="pending">.*Verify Bedrock access/.test(html),
    ]).toEqual([true, true, true]);
  });

  it("offers Retry once a running step has made no progress for a minute", () => {
    const running = session({ status: "working", updatedAt: NOW - 70_000, view: { title: "Installing", progress: "Installing…", fields: [] } });
    const html = wrap(<GuideCard session={running} send={noop} now={NOW} />);
    expect([html.includes("No progress for 1m 10s"), html.includes("Retry")]).toEqual([true, true]);
  });

  it("doesn't offer Retry while a step is making progress", () => {
    const running = session({ status: "working", updatedAt: NOW - 5_000, view: { title: "Installing", progress: "Installing…", fields: [] } });
    expect(wrap(<GuideCard session={running} send={noop} now={NOW} />).includes("Retry")).toBe(false);
  });

  it("can always cancel the setup", () => {
    expect(card(session({ status: "working", view: { title: "Installing", fields: [] } }))).toContain("Cancel setup");
  });

  it("renders a choice as radio buttons, disabling the options the guide disabled", () => {
    const html = card(session());
    expect([radio(html, "i-off").includes("disabled"), radio(html, "i-on").includes("disabled")]).toEqual([true, false]);
  });

  it("preselects the first option that can be picked", () => {
    expect(radio(card(session()), "i-on")).toContain("checked");
  });

  it("masks secret fields", () => {
    expect(card(session())).toContain('type="password"');
  });

  it("shows progress and no form while a step runs", () => {
    const html = card(session({ status: "working", view: { title: "Installing", progress: "Downloading…", fields: [] } }));
    expect([html.includes("Downloading…"), html.includes("Set up runner")]).toEqual([true, false]);
  });

  it("offers Retry with the reason when a step failed", () => {
    const html = card(session({ status: "failed", error: "EC2 access denied", view: { title: "Checking EC2 access", fields: [] } }));
    expect([html.includes("Retry"), html.includes("EC2 access denied")]).toEqual([true, true]);
  });
});

