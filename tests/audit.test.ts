import { expect, test } from "bun:test";
import { audit } from "../src/doctor.ts";
import type * as Cfg from "../src/config.ts";

const line = (out: ReturnType<typeof audit>, what: string) => out.find(x => x.what === what);
const base: Cfg.Config = { guardian: true, transcript: false };

test("a clean config only says that delete on close holds", () => {
  const out = audit(base);
  expect(line(out, "delete on close")?.ok).toBe(true);
  expect(line(out, "unredeemed invites")).toBeUndefined();
  expect(line(out, "contacts without a pinned key")).toBeUndefined();
  expect(line(out, "bot token at rest")).toBeUndefined();
});

test("each unredeemed invite is a nonce that still lets a key in", () => {
  const out = audit({ ...base, invitaciones: { k1: { name: "Sam", at: Date.now() }, k2: { id: "U0X", at: Date.now() } } });
  const l = line(out, "unredeemed invites");
  expect(l?.ok).toBe("warn");
  expect(l?.detail).toContain("2 live");
  expect(l?.detail).toContain("Sam");
});

test("a contact with no pinned key is reported: their first signature is the one that gets pinned", () => {
  const out = audit({ ...base, contacts: { sam: { id: "U0S", name: "Sam" }, ana: { id: "U0A", name: "Ana", pk: "PK" } } });
  const l = line(out, "contacts without a pinned key");
  expect(l?.detail).toContain("Sam");
  expect(l?.detail).not.toContain("Ana");
});

test("the bot token at rest is named for what it is: the real edge", () => {
  const out = audit({ ...base, slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = line(out, "bot token at rest");
  expect(l?.ok).toBe("warn");
  expect(l?.detail).toContain("Rotate it when someone leaves");
});

import { lastStart } from "../src/doctor.ts";

test("the hook's last start is read from disk, including when it failed", () => {
  expect(lastStart(null)).toBeNull();
  expect(lastStart("   ")).toBeNull();
  const ok = lastStart("2026-09-10T12:00:00Z\tok\tsesion registrada con spoochie 0.9.9");
  expect(ok?.ok).toBe(true);
  expect(ok?.detail).toContain("0.9.9");
  // A failure is not a warning: with no binary not a single spoochie arrives, and the
  // session where the error was printed may have closed days ago.
  // "fallo" is the status value startup.ts writes to disk.
  const bad = lastStart("2026-09-10T12:00:00Z\tfallo\tel binario no cuadra con el SHA256SUMS");
  expect(bad?.ok).toBe(false);
  expect(bad?.detail).toContain("SHA256SUMS");
  expect(bad?.detail).toContain("2026-09-10T12:00:00Z");
});

test("doctor says which of the three secrets are still in the clear in the file", () => {
  const inClear = audit({ ...base, keys: { pub: "P", priv: "SECRETA" }, nostr: { sk: "aaa", pk: "bbb" }, slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = line(inClear, "secrets in config.json");
  expect(l?.detail).toContain("signing key");
  expect(l?.detail).toContain("Nostr key");
  expect(l?.detail).toContain("bot token");
  expect(l?.detail).toContain("spoochie keychain on");
  // The ones already in the keychain are not counted.
  const inKeychain = audit({ ...base, keys: { pub: "P", priv: "@llavero" }, nostr: { sk: "@llavero", pk: "bbb" } });
  expect(line(inKeychain, "secrets in config.json")).toBeUndefined();
});

test("if all your contacts have a Nostr key, doctor says you no longer need the token", () => {
  const all = audit({ ...base,
    contacts: { sam: { id: "U_S", name: "Sam", npub: "a".repeat(64) }, ana: { id: "U_A", name: "Ana", npub: "b".repeat(64) } },
    slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = line(all, "you no longer need the bot token");
  expect(l?.detail).toContain("2 contact(s)");
  expect(l?.detail).toContain("spoochie slack off");
  // With a single one lacking a key, no: that one would still need Slack.
  const mixed = audit({ ...base,
    contacts: { sam: { id: "U_S", name: "Sam", npub: "a".repeat(64) }, ana: { id: "U_A", name: "Ana" } },
    slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  expect(line(mixed, "you no longer need the bot token")).toBeUndefined();
});
