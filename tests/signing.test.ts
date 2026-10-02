import { test, expect } from "bun:test";
import { newKeys, makeSignature, makeSignatureV1, checkSignature, checkSignatureV1, canon, verifyEnvelope, WINDOW_MS } from "../src/signing.ts";
import * as Cfg from "../src/config.ts";

const k = newKeys();
const nowS = () => Math.floor(Date.now() / 1000);
const D = (x: Partial<Parameters<typeof makeSignature>[1]> = {}) =>
  ({ id: "a1", kind: "msg", from: "U1", to: "U2", ts: nowS(), app: "0.9.9", ...x });

test("a valid signature checks out and a tampered one does not", () => {
  const d = D();
  const sig = makeSignature(k.priv, d, "hola");
  expect(checkSignature(k.pub, d, "hola", sig)).toBe(true);
  expect(checkSignature(k.pub, d, "hola.", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, from: "U9" }, "hola", sig)).toBe(false);
  expect(checkSignature(newKeys().pub, d, "hola", sig)).toBe(false);
});

test("the signature binds recipient, time, version, subject and thread, which used to travel outside", () => {
  const d = D({ subject: "the modal", thread: { channel: "C1", ts: "1.1" } });
  const sig = makeSignature(k.priv, d, "hola");
  expect(checkSignature(k.pub, d, "hola", sig)).toBe(true);
  // Each of these fields could be changed without invalidating a v1 signature.
  expect(checkSignature(k.pub, { ...d, to: "U9" }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, ts: d.ts + 1 }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, app: "0.9.7" }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, subject: "something else" }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, thread: { channel: "C2", ts: "1.1" } }, "hola", sig)).toBe(false);
});

test("what Slack touches in transit does not break the signature", () => {
  const d = D();
  const sig = makeSignature(k.priv, d, "a & b <c> http://x.y/z\r\n");
  const arrived = "a &amp; b &lt;c&gt; <http://x.y/z>";
  expect(canon(arrived)).toBe("a & b <c> http://x.y/z");
  expect(checkSignature(k.pub, d, arrived, sig)).toBe(true);
});

const envelope = (x: any = {}, priv = k.priv, pub = k.pub) => {
  const d = { id: "t1", kind: "msg", from: "U_SAM", to: "U_YO", ts: nowS(), app: "0.9.9", ...x };
  return { ...d, fromName: "Sam", sv: 2, pk: pub, sig: makeSignature(priv, d, x.texto ?? "x") };
};

test("an id's first key is pinned, and a different one later is rejected", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  // Only the key of someone already in the contacts gets pinned: I invited them or they invited me.
  const c0 = Cfg.load(); Cfg.addContact(c0, { id: "U_SAM", name: "Sam" }); Cfg.save(c0);
  const env = envelope();
  expect(verifyEnvelope(env, "x")).toBe("nueva");
  expect(Cfg.contactById(Cfg.load(), "U_SAM")?.pk).toBe(k.pub);
  expect(verifyEnvelope(env, "x")).toBe("ok");
  const other = newKeys();
  expect(verifyEnvelope(envelope({}, other.priv, other.pub), "x")).toBe("mala");
  expect(Cfg.contactById(Cfg.load(), "U_SAM")?.pk).toBe(k.pub);
});

test("an envelope kept and released again expires", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  const old = envelope({ ts: nowS() - Math.floor(WINDOW_MS / 1000) - 60 });
  expect(verifyEnvelope(old, "x")).toBe("caducada");
  // Not from the future either: a clock running ahead does not grant endless validity.
  expect(verifyEnvelope(envelope({ ts: nowS() + Math.floor(WINDOW_MS / 1000) + 60 }), "x")).toBe("caducada");
  // Nor with no time.
  expect(verifyEnvelope(envelope({ ts: 0 }), "x")).toBe("caducada");
});

test("an envelope signed for someone else does not count in my thread", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  expect(verifyEnvelope(envelope({ to: "U_OTRO" }), "x")).toBe("ajena");
  expect(verifyEnvelope(envelope({ to: "U_YO" }), "x")).toBe("ok");
  // A hello is not addressed to a thread and may have no recipient.
  expect(verifyEnvelope(envelope({ to: "" }), "x")).toBe("ok");
});

test("a v1 signature still counts, but is labelled old", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  // An envelope from 0.9.8: no `sv`, and signed only over id, kind, from and the text.
  const v1 = { id: "t1", kind: "msg", from: "U_SAM", fromName: "Sam", pk: k.pub, sig: makeSignatureV1(k.priv, "t1", "msg", "U_SAM", "x") };
  expect(checkSignatureV1(k.pub, "t1", "msg", "U_SAM", "x", v1.sig)).toBe(true);
  expect(verifyEnvelope(v1, "x")).toBe("vieja");
  // And a tampered v1 is still bad.
  expect(verifyEnvelope({ ...v1, from: "U_OTRO" }, "x")).toBe("mala");
});

test("an unsigned envelope is labelled, not dropped", () => {
  expect(verifyEnvelope({ id: "t2", kind: "msg", from: "U_X" }, "x")).toBe("sin-firma");
});

test("the invite's key stays in the contacts with the name", () => {
  const c: Cfg.Config = { guardian: false, transcript: false };
  Cfg.addContact(c, { id: "U_EDU", name: "Edu", pk: "PK1" });
  Cfg.addContact(c, { id: "U_EDU", name: "Edu" });
  expect(Cfg.contact(c, "edu")?.pk).toBe("PK1");
});

test("stripping an envelope's signature does not sneak it in: attacking would just mean not signing", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  // From a stranger, an unsigned envelope gets in labelled: it may be an old version.
  expect(verifyEnvelope({ id: "t9", kind: "msg", from: "U_NADIE" }, "x")).toBe("sin-firma");
  // As soon as I have their key pinned, an unsigned envelope from them is an attack, not an old version.
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_NADIE", name: "Nadie", pk: k.pub }); Cfg.save(c);
  expect(verifyEnvelope({ id: "t9", kind: "msg", from: "U_NADIE" }, "x")).toBe("degradada");
});

test("a correctly signed envelope from an id not in your contacts pins no key", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  // Anyone able to post with the bot token can make up an id. verifyEnvelope used to add
  // them to the contacts, under the name they gave themselves, just for seeing them write once.
  expect(verifyEnvelope(envelope({ from: "U_INTRUSO" }), "x")).toBe("desconocida");
  expect(Cfg.contactById(Cfg.load(), "U_INTRUSO")).toBeNull();
});

/**
 * `kindOfMsg` travelled outside the signature, and it decides whether the guardian reads
 * the message: anything that was not "text" was skipped. So changing one word nobody
 * signed switched the guardian off for that message, without touching the text or
 * breaking the signature.
 *
 * It goes into v2 without breaking anyone: v2 has not shipped in any published version
 * (the latest is 0.9.8 and it signs with v1).
 */
test("changing kindOfMsg invalidates the signature", () => {
  const k = newKeys();
  const c = Cfg.load();
  c.slack = { userId: "U_ME" } as any;
  Cfg.addContact(c, { id: "U_KOM", name: "Ana", pk: k.pub } as any);
  Cfg.save(c);
  const env: any = { id: "kom", kind: "msg", from: "U_KOM", to: "U_ME", ts: Math.floor(Date.now() / 1000), sv: 2, app: "0.9.9", pk: k.pub, kindOfMsg: "text" };
  env.sig = makeSignature(k.priv, env, "look at this");
  expect(verifyEnvelope(env, "look at this")).toBe("ok");
  expect(verifyEnvelope({ ...env, kindOfMsg: "patch" }, "look at this")).toBe("mala");
  // Removing it entirely does not work either: "" is signed and "text" is not "".
  expect(verifyEnvelope({ ...env, kindOfMsg: undefined }, "look at this")).toBe("mala");
});
