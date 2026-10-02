import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("masking asks the keychain instead of remembering a state", () => {
  // Without this the migration undid itself: `load` fills in the real secret and any
  // later `save` (there is one in almost every operation) wrote it in the clear again.
  // It is decided by asking: if the keychain has the key, the file gets the marker.
  const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const f = source.slice(source.indexOf("export function mask"), source.indexOf("export function touchContact"));
  expect(f).toContain("L.read(L.ACCOUNTS.firma)");
  expect(f).toContain("L.read(L.ACCOUNTS.nostr)");
  expect(f).toContain("L.read(L.ACCOUNTS.bot)");
  // And `save` always goes through it, not only when someone remembers.
  expect(source).toContain("JSON.stringify(mask(c), null, 2)");
});

test("if the keychain does not answer the marker stays, and nothing gets signed with it", () => {
  const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const f = source.slice(source.indexOf("export function fillFromKeychain"), source.indexOf("export function toKeychain"));
  // The pattern is `const v = L.read(...); if (v)`: with no value nothing is touched, so
  // spoochie says "I have no key" instead of signing with the string "@llavero" and the
  // other side dropping the envelopes without knowing why.
  expect(f).toContain("if (v)");
  expect(f).not.toContain("?? L.MARKER");
});

test("the three secrets that get moved are the three there are", () => {
  const { ACCOUNTS } = require("../src/keychain.ts");
  expect(Object.keys(ACCOUNTS).sort()).toEqual(["bot", "firma", "nostr"]);
  const cfg = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  // The ed25519 private key, the Nostr secret and the bot token. If a fourth secret shows
  // up in the config, this test does not know it: that is why they are named here.
  expect(cfg).toContain("keys?: { pub: string; priv: string }");
  expect(cfg).toContain("nostr?: { sk?: string");
  expect(cfg).toContain("botToken?: string");
});
