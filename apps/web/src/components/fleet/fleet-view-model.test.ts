import { describe, expect, it } from "vitest";
import type { FleetModel, FleetTask } from "./fleet-types.js";
import {
  activeRun,
  ago,
  artifactsNewestFirst,
  defaultInput,
  dayLabel,
  duration,
  finishedSince,
  groupByAgent,
  groupByDay,
  inboxOf,
  initialDraft,
  runnerHealth,
  runnerLocation,
  runsOf,
  runStrip,
  runTitle,
  selectedOrNext,
} from "./fleet-view-model.js";

const NOW = 1_000_000;

const KEY = "ec2/dadjokes";

const task = (overrides: Partial<FleetTask>): FleetTask => ({
  id: "t1",
  runner: "ec2",
  agent: "dadjokes",
  prompt: "kubernetes",
  state: "completed",
  statusText: "jokes delivered",
  artifacts: [],
  createdAt: NOW - 60_000,
  updatedAt: NOW - 55_000,
  ...overrides,
});

const model = (tasks: FleetTask[], example = "penguins"): FleetModel => ({
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
      location: null,
    },
  },
  agents: {
    [KEY]: {
      key: KEY,
      runner: "ec2",
      id: "dadjokes",
      name: "Dad jokes",
      description: "Dad jokes",
      input: { label: "Topic", hint: "what about", example },
      schedule: null,
    },
  },
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  notifications: [],
});

describe("runsOf", () => {
  it("lists an agent's runs newest first", () => {
    const m = model([task({ id: "old", createdAt: NOW - 90_000 }), task({ id: "new", createdAt: NOW - 10_000 })]);
    expect(runsOf(m, KEY).map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("excludes other agents' runs", () => {
    expect(runsOf(model([task({ agent: "other" })]), KEY)).toEqual([]);
  });

  it("excludes the same agent id on another runner", () => {
    expect(runsOf(model([task({ runner: "laptop" })]), KEY)).toEqual([]);
  });
});

describe("activeRun", () => {
  it("returns the run that has not finished", () => {
    const m = model([task({ id: "done" }), task({ id: "live", state: "working", createdAt: NOW - 1_000 })]);
    expect(activeRun(m, KEY)?.id).toBe("live");
  });

  it("is undefined when every run has finished", () => {
    expect(activeRun(model([task({ state: "failed" })]), KEY)).toBeUndefined();
  });
});

describe("defaultInput", () => {
  it("prefers the last prompt over the card example", () => {
    expect(defaultInput(model([task({ prompt: "coffee" })]), KEY)).toBe("coffee");
  });

  it("falls back to the card example when there are no runs", () => {
    expect(defaultInput(model([]), KEY)).toBe("penguins");
  });

  it("is empty without runs or examples", () => {
    expect(defaultInput(model([], ""), KEY)).toBe("");
  });
});

describe("artifactsNewestFirst", () => {
  it("puts the last artifact first", () => {
    const t = task({
      artifacts: [
        { id: "metrics", name: "metrics", text: "raw" },
        { id: "summary", name: "summary", text: "ok" },
      ],
    });
    expect(artifactsNewestFirst(t).map((a) => a.id)).toEqual(["summary", "metrics"]);
  });
});

describe("inboxOf", () => {
  it("lists unread finished runs newest first", () => {
    const m = model([task({ id: "old", updatedAt: NOW - 90_000 }), task({ id: "new", updatedAt: NOW - 1_000 })]);
    expect(inboxOf(m).map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("drops acknowledged runs", () => {
    expect(inboxOf(model([task({ ackedAt: NOW })]))).toEqual([]);
  });

  it("drops runs still in progress", () => {
    expect(inboxOf(model([task({ state: "working" })]))).toEqual([]);
  });
});

describe("runTitle", () => {
  it("combines the agent's input label with the prompt", () => {
    const m = model([]);
    expect(runTitle(m, task({ prompt: "coffee" }))).toBe("Topic: coffee");
  });

  it("falls back to a report title without a prompt", () => {
    expect(runTitle(model([]), task({ prompt: "" }))).toBe("Your dad jokes");
  });
});

describe("runStrip", () => {
  it("orders the last runs oldest to newest", () => {
    const m = model([task({ id: "a", createdAt: NOW - 30_000 }), task({ id: "b", createdAt: NOW - 10_000 })]);
    expect(runStrip(m, KEY).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("keeps at most the last ten runs", () => {
    const many = Array.from({ length: 14 }, (_, i) => task({ id: `t${i}`, createdAt: NOW - i * 1_000 }));
    expect(runStrip(model(many), KEY)).toHaveLength(10);
  });
});

describe("runnerLocation", () => {
  it("uses the location the runner reports", () => {
    expect(runnerLocation({ ...model([]).runners.ec2!, location: "EC2 us-west-2" })).toBe("EC2 us-west-2");
  });

  it("falls back to the runner's host", () => {
    expect(runnerLocation({ ...model([]).runners.ec2!, location: null })).toBe("127.0.0.1:9471");
  });
});

describe("formatting", () => {
  it.each([
    [2_000, "just now"],
    [42_000, "42s ago"],
    [5 * 60_000, "5m ago"],
    [3 * 3_600_000, "3h ago"],
    [2 * 86_400_000, "2d ago"],
  ])("ago(%i ms) is %s", (elapsed, expected) => {
    expect(ago(NOW, NOW - elapsed)).toBe(expected);
  });

  it.each([
    [6_000, "6s"],
    [62_000, "1m 02s"],
  ])("duration(%i ms) is %s", (ms, expected) => {
    expect(duration(ms)).toBe(expected);
  });

  it("shows the retry countdown for an unreachable runner", () => {
    const m = model([]);
    const runner = { ...m.runners.ec2!, status: "unreachable" as const, nextCheckAt: NOW + 8_000 };
    expect(runnerHealth(m, runner)).toBe("retry in 8s");
  });
});

describe("runnerLocation for guide-made runners", () => {
  it("falls back to how the runner was set up", () => {
    const r = { ...model([]).runners.ec2!, location: null, origin: { guide: "aws", summary: "EC2 i-1 · us-west-2", teardown: null } };
    expect(runnerLocation(r)).toBe("EC2 i-1 · us-west-2");
  });

  it("says when it isn't connected", () => {
    expect(runnerLocation({ ...model([]).runners.ec2!, location: null, link: { state: "down", error: null } })).toBe("not connected");
  });
});

describe("initialDraft", () => {
  it("uses suggested values and the first selectable choice", () => {
    const draft = initialDraft({
      title: "x",
      fields: [
        { id: "name", label: "", kind: "text", value: "ec2" },
        { id: "pick", label: "", kind: "choice", options: [{ value: "a", label: "", disabled: true }, { value: "b", label: "" }] },
        { id: "token", label: "", kind: "secret" },
      ],
    });
    expect(draft).toEqual({ name: "ec2", pick: "b", token: "" });
  });
});


describe("finishedSince", () => {
  const working = task({ state: "working" });

  it("reports a run that finished since the last Model", () => {
    expect(finishedSince(model([working]), model([task({})])).map((t) => t.id)).toEqual(["t1"]);
  });

  it("reports a run that arrived already finished", () => {
    expect(finishedSince(model([]), model([task({})])).map((t) => t.id)).toEqual(["t1"]);
  });

  it("doesn't report a run again", () => {
    expect(finishedSince(model([task({})]), model([task({})]))).toEqual([]);
  });

  it("reports nothing for the first Model, so connecting stays quiet", () => {
    expect(finishedSince(null, model([task({})]))).toEqual([]);
  });

  it("leaves out runs already marked read", () => {
    expect(finishedSince(model([working]), model([task({ ackedAt: NOW })]))).toEqual([]);
  });
});

describe("inbox layout helpers", () => {
  const noon = new Date(2026, 10, 24, 12).getTime();
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();

  it("labels today and yesterday by calendar day, not by 24 hours", () => {
    expect([dayLabel(at(24, 0), noon), dayLabel(at(23, 23), noon), dayLabel(at(23, 1), noon)]).toEqual(["Today", "Yesterday", "Yesterday"]);
  });

  it("names older days by date", () => {
    expect(dayLabel(at(20, 9), noon)).not.toMatch(/Today|Yesterday/);
  });

  it("groups runs under one heading per day, in order", () => {
    const runs = [task({ id: "a", updatedAt: at(24, 9) }), task({ id: "b", updatedAt: at(24, 8) }), task({ id: "c", updatedAt: at(23, 9) })];
    expect(groupByDay(runs, noon).map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
    ]);
  });

  it("groups runs by agent, the agent with the newest run first", () => {
    const runs = [task({ id: "a", agent: "geofact" }), task({ id: "b" }), task({ id: "c", agent: "geofact" })];
    expect(groupByAgent(model(runs), runs).map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ["ec2/geofact", ["a", "c"]],
      ["ec2/dadjokes", ["b"]],
    ]);
  });

  it("keeps the selection while it is in the list", () => {
    const runs = [task({ id: "a" }), task({ id: "b" })];
    expect(selectedOrNext(runs, "b", 0)?.id).toBe("b");
  });

  it("moves to the result that took the place of one marked read", () => {
    expect(selectedOrNext([task({ id: "a" }), task({ id: "c" })], "b", 1)?.id).toBe("c");
  });

  it("moves to the last result when the last one was marked read", () => {
    expect(selectedOrNext([task({ id: "a" })], "b", 1)?.id).toBe("a");
  });
});
