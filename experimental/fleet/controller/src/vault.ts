import { Entry } from "@napi-rs/keyring";
import { attempt as attemptAsync, type Outcome } from "./outcome.js";
import type { SecretRef } from "./types.js";

export interface SecretStore {
  get(key: string): Promise<Outcome<string | null>>;
  set(key: string, value: string): Promise<Outcome<void>>;
  delete(key: string): Promise<Outcome<void>>;
}

const SERVICE = "agent-fleet";

const attempt = async <T>(f: () => T): Promise<Outcome<T>> => {
  const r = await attemptAsync(f);
  return r.ok ? r : { ok: false, error: `OS vault: ${r.error}` };
};

/** macOS Keychain, Linux Secret Service, Windows Credential Manager (via @napi-rs/keyring). */
export const osVault = (service = SERVICE): SecretStore => ({
  get: (key) => attempt(() => new Entry(service, key).getPassword() ?? null),
  set: (key, value) => attempt(() => new Entry(service, key).setPassword(value)),
  delete: (key) =>
    attempt(() => {
      new Entry(service, key).deletePassword();
    }),
});

export const memoryVault = (initial: Record<string, string> = {}): SecretStore => {
  const secrets = new Map(Object.entries(initial));
  return {
    get: (key) => Promise.resolve({ ok: true, value: secrets.get(key) ?? null }),
    set: (key, value) => {
      secrets.set(key, value);
      return Promise.resolve({ ok: true, value: undefined });
    },
    delete: (key) => {
      secrets.delete(key);
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
};

export const vaultFromEnv = (kind = process.env.FLEET_VAULT ?? "os"): SecretStore => (kind === "memory" ? memoryVault() : osVault());

export const reveal = async (vault: SecretStore, ref: SecretRef): Promise<Outcome<string>> => {
  if (ref.kind === "inline") return { ok: true, value: ref.value };
  const got = await vault.get(ref.key);
  if (!got.ok) return got;
  return got.value === null ? { ok: false, error: `secret ${ref.key} is missing from the vault` } : { ok: true, value: got.value };
};
