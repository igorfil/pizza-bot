import { describe, expect, it } from "vitest";
import type { FleetModel, FleetTask } from "./fleet-types.js";
import { activeRun, ago, artifactsNewestFirst, defaultInput, duration, inboxOf, runnerHealth, runnerLocation, runsOf, runStrip, runTitle } from "./fleet-view-model.js";

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
      url: "http://127.0.0.1:9471",
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
