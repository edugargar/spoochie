import { expect, test } from "bun:test";
import * as Cfg from "../src/config.ts";
import { newInvite, redeemInvite, bindKey, helloByNostr, helloBySlack, INVITE_EXPIRES_MS } from "../src/keys.ts";

const cfg = (): Cfg.Config => ({ guardian: false, transcript: false } as any);
const K_SAM = "a".repeat(64), K_X = "f".repeat(64), K_BEA = "b".repeat(64);

test("an invite is redeemed only once and expires after 30 days", () => {
  const c = cfg();
  const k = newInvite(c, { id: "U_SAM", name: "Sam" }, 1000);
  expect(k).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(redeemInvite(c, "does-not-exist", 2000)).toBeNull();
  expect(redeemInvite(c, k, 2000)).toEqual({ id: "U_SAM", name: "Sam" });
  expect(redeemInvite(c, k, 3000)).toBeNull();
  const old = newInvite(c, { name: "Sam" }, 1000);
  expect(redeemInvite(c, old, 1000 + INVITE_EXPIRES_MS + 1)).toBeNull();
});

test("a key already in the contacts is not replaced, and one key does not hang off two ids", () => {
  const c = cfg();
  expect(bindKey(c, { id: "U_SAM", name: "Sam", npub: K_SAM })).toBe("nueva");
  expect(bindKey(c, { id: "U_SAM", name: "Sam", npub: K_SAM, relays: ["wss://nuevo"] })).toBe("igual");
  expect((Cfg.contactById(c, "U_SAM") as any).relays).toEqual(["wss://nuevo"]);
  expect(bindKey(c, { id: "U_SAM", name: "Sam", npub: K_X })).toBe("conflicto");
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBe(K_SAM);
  expect(bindKey(c, { id: "U_OTRO", name: "Otro", npub: K_SAM })).toBe("conflicto");
  expect(Cfg.contactById(c, "U_OTRO")).toBeNull();
});

test("a hello over Nostr only gets in with my invite's nonce, and is bound to what I wrote down", () => {
  const c = cfg();
  Cfg.addContact(c, { id: "U_SAM", name: "Sam" });
  // The 07-09 attack: a stranger claims to be Sam's Slack. No nonce, out.
  expect(helloByNostr(c, { from: K_X, name: "Sam" })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBeUndefined();
  // I invite Sam; their hello carries the nonce: it is bound to the id I wrote down, even if the hello says another name.
  const k = newInvite(c, { id: "U_SAM", name: "Sam" });
  const d = helloByNostr(c, { from: K_SAM, name: "Samuel", k, relays: ["wss://sam"] });
  expect(d).toMatchObject({ ok: true, id: "U_SAM", name: "Sam", vinculo: "nueva" });
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBe(K_SAM);
  // The same nonce does not count twice, not even for another key.
  expect(helloByNostr(c, { from: K_X, name: "Sam", k })).toMatchObject({ ok: false });
  // A known key can say hello again without a nonce (relay change), but cannot change id.
  expect(helloByNostr(c, { from: K_SAM, name: "Sam", relays: ["wss://otro"] })).toMatchObject({ ok: true, vinculo: "igual" });
  // Even with a valid nonce, nobody replaces Sam's key.
  const k2 = newInvite(c, { id: "U_SAM", name: "Sam" });
  expect(helloByNostr(c, { from: K_X, name: "Sam", k: k2 })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBe(K_SAM);
  // A printed invite (no id) binds to the key, never to a Slack id the hello claims.
  const k3 = newInvite(c, { name: "Sam" });
  expect(helloByNostr(c, { from: K_BEA, name: "Sam", k: k3 })).toMatchObject({ ok: true, id: `nostr:${K_BEA}`, name: "Sam" });
});

test("a hello over Slack only gets in signed with the already pinned key, or from an id already in the contacts", () => {
  const c = cfg();
  Cfg.addContact(c, { id: "U_BEA", name: "Bea", pk: "PK_BEA" });
  Cfg.addContact(c, { id: "U_SAM", name: "Sam" });
  // Unsigned or with a forged signature: no, even if the id is known. That is how it was before 07-09.
  expect(helloBySlack(c, { from: "U_BEA", name: "Bea", np: K_X, verdict: "sin-firma" })).toMatchObject({ ok: false });
  expect(helloBySlack(c, { from: "U_BEA", name: "Bea", np: K_X, verdict: "mala" })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_BEA") as any).npub).toBeUndefined();
  // An id not in the contacts does not get added just for signing correctly the first time.
  expect(helloBySlack(c, { from: "U_NADIE", name: "Nadie", np: K_X, verdict: "nueva" })).toMatchObject({ ok: false });
  expect(Cfg.contactById(c, "U_NADIE")).toBeNull();
  // Signed with Bea's pinned key: gets in.
  expect(helloBySlack(c, { from: "U_BEA", name: "Bea", np: K_BEA, verdict: "ok" })).toMatchObject({ ok: true, vinculo: "nueva" });
  // Sam is in the contacts with no pinned key: their first signature counts (as with their envelopes).
  expect(helloBySlack(c, { from: "U_SAM", name: "Sam", np: K_SAM, verdict: "nueva" })).toMatchObject({ ok: true });
  // And once there is a key, nobody changes it over Slack even with a good signature.
  expect(helloBySlack(c, { from: "U_BEA", name: "Bea", np: K_X, verdict: "ok" })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_BEA") as any).npub).toBe(K_BEA);
});
