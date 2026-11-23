import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { upcast } from "./runtime.js";
import type { Msg } from "./types.js";
import { memoryVault, osVault, reveal } from "./vault.js";

describe("memory vault", () => {
  test("stores, reads and deletes", async () => {
    const vault = memoryVault();
    await vault.set("k", "v");
    const read = await vault.get("k");
    await vault.delete("k");
    expect([read, await vault.get("k")]).toEqual([
      { ok: true, value: "v" },
      { ok: true, value: null },
    ]);
  });

  test("an inline secret reveals without the vault", async () => {
    expect(await reveal(memoryVault(), { kind: "inline", value: "old" })).toEqual({ ok: true, value: "old" });
  });
});

// The real keychain: macOS always has one; on Linux and Windows CI it may be missing, so opt in there.
describe.runIf(process.platform === "darwin" || process.env.FLEET_TEST_OS_VAULT === "1")("OS vault", () => {
  test("round-trips a secret through the OS keychain", async () => {
    const vault = osVault("agent-fleet-test");
    const key = `test/${randomUUID()}`;
    await vault.set(key, "s3cret");
    const read = await vault.get(key);
    await vault.delete(key);
    expect([read, await vault.get(key)]).toEqual([
      { ok: true, value: "s3cret" },
      { ok: true, value: null },
    ]);
  });
});

describe("replaying old Msg logs", () => {
  test("an AddRunner with a plain URL and token becomes a direct runner with an inline token", () => {
    const old = { type: "AddRunner", name: "ec2", url: "http://127.0.0.1:9471/", token: "t" } as unknown as Msg;
    expect(upcast(old)).toEqual({
      type: "AddRunner",
      name: "ec2",
      transport: { kind: "direct", url: "http://127.0.0.1:9471" },
      token: { kind: "inline", value: "t" },
      origin: null,
    });
  });

  test("a RemoveRunner without teardown never tears down", () => {
    expect(upcast({ type: "RemoveRunner", name: "x" } as unknown as Msg)).toEqual({ type: "RemoveRunner", name: "x", teardown: false });
  });

  test("current Msgs pass through unchanged", () => {
    const msg: Msg = { type: "Tick", now: 1 };
    expect(upcast(msg)).toBe(msg);
  });
});
