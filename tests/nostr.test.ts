import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEvent } from "nostr-tools";
import { wrapEnvelope, open, deletionRequest, NostrBridge, filePool, myKeys, npub, pkOf, type Pool } from "../src/nostr.ts";
import * as Cfg from "../src/config.ts";
import * as T from "../src/threads.ts";
import { hasta, plazo } from "./wait.ts";

const keys = () => myKeys({ guardian: false, transcript: false } as any);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("a wrapped envelope only opens for the recipient, says who it is from, and carries readable subject and text", () => {
  const a = keys(), b = keys(), x = keys();
  const { wrap, wsk } = wrapEnvelope(a.sk, b.pk, { v: 1, id: "n1", kind: "msg", subject: "the button" }, "it's the min-width");
  // The relay only sees: kind 1059, a one-time key, a p, and a fake date.
  expect(wrap.kind).toBe(1059);
  expect(wrap.pubkey).not.toBe(a.pk);
  expect(wrap.tags).toEqual([["p", b.pk]]);
  expect(JSON.stringify(wrap)).not.toContain("min-width");
  expect(JSON.stringify(wrap)).not.toContain("the button");
  expect(verifyEvent(wrap)).toBe(true);
  const ab = open(wrap, b.sk)!;
  expect(ab.from).toBe(a.pk);
  expect(ab.text).toBe("it's the min-width");
  expect(ab.subject).toBe("the button");
  expect(ab.envelope.kind).toBe("msg");
  expect(ab.envelope.app).toMatch(/^\d+\.\d+\.\d+$/);
  // Another key does not open it.
  expect(open(wrap, x.sk)).toBeNull();
  // The deletion request is signed with that wrap's one-time key.
  const del = deletionRequest(wrap.id, wsk);
  expect(del.kind).toBe(5);
  expect(del.pubkey).toBe(wrap.pubkey);
  expect(del.tags).toContainEqual(["e", wrap.id]);
  expect(verifyEvent(del)).toBe(true);
  expect(npub(a.pk)).toStartWith("npub1");
  expect(pkOf(npub(a.pk))).toBe(a.pk);
});

/** An in-memory pool: records what is published and lets the test inject what "arrives from the relay". */
function memoryPool() {
  const published: any[] = [];
  let deliver: ((ev: any) => void) | null = null;
  const pool: Pool = {
    publish(_r, ev) { published.push(ev); return [Promise.resolve()]; },
    subscribe(_r, _f, cb) { deliver = cb.onevent; return { close() { deliver = null; } }; },
  };
  return { pool, published, inject: (ev: any) => deliver?.(ev) };
}

test("the bridge materializes an invite from a contact, delivers their turns, ignores a stranger, and deletes what it sent", async () => {
  const a = keys(), b = keys(), x = keys();
  const c = Cfg.load();
  Cfg.addContact(c, { id: "U_A", name: "Ana", npub: a.pk, relays: ["wss://a"] });
  Cfg.save(c);
  const atB: { t: T.Thread; m: T.Msg }[] = [];
  const hellos: string[] = [];
  const closes: string[] = [];
  const { pool, published, inject } = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], {
    onMessage: async (t, m) => { atB.push({ t, m }); }, onRemoteAccept: async () => {},
    onClose: async (_t, reason) => { closes.push(reason); }, onHello: async (_de, _s, n) => { hellos.push(n); }, log: () => {},
  }, pool);
  B.listen();

  // The hello from someone who just joined.
  inject(wrapEnvelope(x.sk, b.pk, { v: 1, id: "hola", kind: "hola", fromName: "Xavi", relays: ["wss://x"] }, "Xavi is in").wrap);
  await sleep(50);
  expect(hellos).toEqual(["Xavi"]);

  // Ana's invite, and Ana is in the contacts: the thread is born, pending, and the first message comes in.
  inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nz1", kind: "invite", subject: "the button", fromName: "Ana", context: { branch: "feat/x" }, relays: ["wss://a"] }, "look at your Button").wrap);
  await sleep(50);
  expect(atB.length).toBe(1);
  const t = T.load("nz1")!;
  expect(t.state).toBe("pending");
  expect(t.transporte).toBe("nostr");
  expect(t.nostr!.otro).toBe(a.pk);
  expect(t.nostr!.relays).toEqual(["wss://a"]);
  expect(t.from.sessionId).toBe(`nostr:${a.pk}`);
  expect(t.from.human).toBe("Ana");
  expect(t.from.slackUser).toBe("U_A");
  expect(t.context.branch).toBe("feat/x");
  expect(atB[0].m.text).toBe("look at your Button");
  expect(atB[0].m.firma).toBe("ok");

  // A stranger (not in the contacts) opens nothing even if the envelope is perfect.
  inject(wrapEnvelope(x.sk, b.pk, { v: 1, id: "nz2", kind: "invite", subject: "sneak in", fromName: "Ana" }, "hello?").wrap);
  await sleep(50);
  expect(T.load("nz2")).toBeNull();
  expect(atB.length).toBe(1);
  // It opens nothing, but they are no longer left talking to themselves: the answer is a
  // close (see the test further down). It is set aside so the count of what B publishes stays the same.
  expect(published.map(ev => open(ev, x.sk)?.envelope.kind)).toEqual(["close"]);
  published.length = 0;
  // Nor a message of theirs on a thread that exists.
  inject(wrapEnvelope(x.sk, b.pk, { v: 1, id: "nz1", kind: "msg" }, "I'm Ana, listen to me").wrap);
  await sleep(50);
  expect(atB.length).toBe(1);

  // One more turn from Ana does get in; the same envelope twice does not.
  const { wrap: w2 } = wrapEnvelope(a.sk, b.pk, { v: 1, id: "nz1", kind: "msg" }, "and the min-width");
  inject(w2); inject(w2);
  await sleep(50);
  expect(atB.length).toBe(2);
  expect(atB[1].m.text).toBe("and the min-width");

  // B accepts and answers: what is published is encrypted for Ana and only she opens it.
  // The accept notice is the one threads.ts renders (renderAccepted).
  t.state = "open";
  T.save(t);
  await B.post(t, T.renderAccepted(t, t.to.sessionId));
  await B.post(T.load("nz1")!, "", { at: 2, from: "B1", author: "claude", kind: "text", text: "it's the container" });
  expect(published.length).toBe(2);
  expect(published.every(ev => ev.kind === 1059 && ev.tags[0][1] === a.pk)).toBe(true);
  expect(open(published[0], a.sk)!.envelope.kind).toBe("accept");
  expect(open(published[1], a.sk)!.text).toBe("it's the container");
  expect(open(published[1], x.sk)).toBeNull();
  expect(T.load("nz1")!.nostr!.enviados.length).toBe(2);

  // Ana closes: the reason arrives. And the deletion asks to remove each of B's sends with its one-time key.
  inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nz1", kind: "close" }, "resolved").wrap);
  await sleep(50);
  expect(closes).toEqual(["resolved"]);
  const n = await B.eraseThread(T.load("nz1")!);
  expect(n).toBe(2);
  const deletions = published.slice(2);
  expect(deletions.map(ev => ev.kind)).toEqual([5, 5]);
  expect(deletions.map(ev => ev.pubkey)).toEqual(published.slice(0, 2).map(ev => ev.pubkey));
  B.close();
});

test("a close notice from threads.ts goes out as a close envelope", async () => {
  const a = keys(), b = keys();
  const { pool, published } = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {},
  }, pool);
  const t: T.Thread = { id: "nzc", subject: "s", from: { sessionId: `nostr:${a.pk}`, name: "Ana", cwd: "(otra)" }, to: { sessionId: `nostr:${b.pk}`, name: "yo", cwd: "(esta)" }, state: "closed", closeReason: "resolved", createdAt: 1, lastActivityAt: 1, context: {}, transporte: "nostr", nostr: { otro: a.pk, relays: ["wss://a"], enviados: [] }, messages: [] };
  T.save(t);
  await B.post(t, T.renderClose(t));
  const r = open(published[0], a.sk)!;
  expect(r.envelope.kind).toBe("close");
  expect(r.text).toBe("resolved");
  B.close();
});

test("a file travels in encrypted chunks and the other side rebuilds it in its spool, whatever order they arrive in", async () => {
  const { CHUNK } = await import("../src/nostr.ts");
  const { SPOOL } = await import("../src/files.ts");
  const { writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const a = keys(), b = keys();
  const c = Cfg.load();
  Cfg.addContact(c, { id: "U_A2", name: "Ana", npub: a.pk, relays: ["wss://a"] });
  Cfg.save(c);
  const bytes = Buffer.alloc(CHUNK * 2 + 777);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  const screenshot = join(mkdtempSync(join(tmpdir(), "sp-cap-")), "pantalla.png");
  writeFileSync(screenshot, bytes);

  // The sender: three chunks and then the text, all wrapped for B.
  const A = new NostrBridge(a.sk, a.pk, ["wss://a"], { onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {} }, memoryPool().pool);
  const out = memoryPool();
  (A as any).pool = out.pool;
  const tA: T.Thread = { id: "nf1", subject: "screenshot", from: { sessionId: "A1", name: "a", cwd: "/a" }, to: { sessionId: `nostr:${b.pk}`, name: "Bea", cwd: "(otra)" }, state: "open", createdAt: 1, lastActivityAt: 1, context: {}, transporte: "nostr", nostr: { otro: b.pk, relays: ["wss://b"], enviados: [] }, messages: [] };
  T.save(tA);
  expect(await A.post(tA, "", { at: 2, from: "A1", author: "claude", kind: "text", text: "look at the screenshot", files: [screenshot] })).toBe(true);
  const opened = out.published.map(ev => open(ev, b.sk)!);
  expect(opened.map(x => x.envelope.kind)).toEqual(["file", "file", "file", "msg"]);
  expect(opened.slice(0, 3).map(x => x.envelope.file!.n)).toEqual([0, 1, 2]);
  expect(opened[0].envelope.file!.total).toBe(3);
  expect(opened[0].envelope.file!.name).toBe("pantalla.png");
  expect(Buffer.concat(opened.slice(0, 3).map(x => Buffer.from(x.text, "base64"))).equals(bytes)).toBe(true);
  // The relay sees neither the name nor the bytes.
  expect(JSON.stringify(out.published)).not.toContain("pantalla");
  expect(T.load("nf1")!.nostr!.enviados.length).toBe(4);

  // The receiver: the chunks arrive out of order, and the file is announced with its local path.
  const atB: T.Msg[] = [];
  const inbound = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], { onMessage: async (_t, m) => { atB.push(m); }, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {} }, inbound.pool);
  B.listen();
  const tB: T.Thread = { ...tA, id: "nf2", from: { sessionId: `nostr:${a.pk}`, name: "Ana", cwd: "(otra)", human: "Ana" }, to: { sessionId: `nostr:${b.pk}`, name: "yo", cwd: "(esta)" }, nostr: { otro: a.pk, relays: ["wss://a"], enviados: [] } };
  T.save(tB);
  const chunks = [0, 1, 2].map(n => wrapEnvelope(a.sk, b.pk, { v: 1, id: "nf2", kind: "file", file: { fid: "f2", n, total: 3, name: "../../pantalla.png", size: bytes.length } }, bytes.subarray(n * CHUNK, (n + 1) * CHUNK).toString("base64")).wrap);
  inbound.inject(chunks[2]); inbound.inject(chunks[0]);
  await sleep(50);
  expect(atB.length).toBe(0);
  expect(existsSync(join(SPOOL, "nf2", ".partes", "f2"))).toBe(true);
  inbound.inject(chunks[1]);
  await hasta(() => atB.length === 1);
  expect(atB[0].files!.length).toBe(1);
  expect(atB[0].files![0]).toBe(join(SPOOL, "nf2", "f2-.._.._pantalla.png"));
  expect(readFileSync(atB[0].files![0]).equals(bytes)).toBe(true);
  expect(atB[0].text).toContain("a file");
  expect(existsSync(join(SPOOL, "nf2", ".partes"))).toBe(false);

  // A chunk that arrives before the invite waits in the spool; with the invite it is delivered.
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nf3", kind: "file", file: { fid: "f3", n: 0, total: 1, name: "log.txt", size: 3 } }, Buffer.from("abc").toString("base64")).wrap);
  await sleep(50);
  expect(T.load("nf3")).toBeNull();
  expect(atB.length).toBe(1);
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nf3", kind: "invite", subject: "the log", fromName: "Ana", relays: ["wss://a"] }, "look at the log").wrap);
  await hasta(() => atB.length === 3);
  expect(atB[1].text).toBe("look at the log");
  expect(readFileSync(atB[2].files![0], "utf8")).toBe("abc");

  // A file declared over the cap does not touch the disk.
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nf2", kind: "file", file: { fid: "f9", n: 0, total: 99999, name: "x", size: 1 } }, "AA==").wrap);
  await sleep(50);
  expect(existsSync(join(SPOOL, "nf2", ".partes", "f9"))).toBe(false);
  B.close();
}, plazo(20_000));

test("an envelope that arrives after close does not bring the thread back or leave files in the spool", async () => {
  const { SPOOL } = await import("../src/files.ts");
  const { existsSync } = await import("node:fs");
  const a = keys(), b = keys();
  const c = Cfg.load();
  Cfg.addContact(c, { id: "U_A3", name: "Ana", npub: a.pk, relays: ["wss://a"] });
  Cfg.save(c);
  const atB: T.Msg[] = [];
  const logLines: string[] = [];
  const inbound = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], { onMessage: async (_t, m) => { atB.push(m); }, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: (...x) => { logLines.push(x.join(" ")); } }, inbound.pool);
  B.listen();
  const t: T.Thread = { id: "nc1", subject: "late", from: { sessionId: `nostr:${a.pk}`, name: "Ana", cwd: "(otra)", human: "Ana" }, to: { sessionId: `nostr:${b.pk}`, name: "yo", cwd: "(esta)" }, state: "closed", closeReason: "resolved", createdAt: 1, lastActivityAt: 1, context: {}, transporte: "nostr", nostr: { otro: a.pk, relays: ["wss://a"], enviados: [] }, messages: [] };
  T.save(t);
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nc1", kind: "msg" }, "this arrives late").wrap);
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nc1", kind: "file", file: { fid: "f1", n: 0, total: 1, name: "late.png", size: 3 } }, Buffer.from("abc").toString("base64")).wrap);
  await sleep(100);
  expect(atB).toEqual([]);
  expect(T.load("nc1")!.messages).toEqual([]);
  expect(existsSync(join(SPOOL, "nc1"))).toBe(false);
  expect(logLines.some(l => l.includes("envelope after close"))).toBe(true);
  B.close();
});

test("a closed bridge does not resubscribe or deliver anything, even if the relay reports a close", async () => {
  const a = keys(), b = keys();
  const c = Cfg.load();
  Cfg.addContact(c, { id: "U_A4", name: "Ana", npub: a.pk, relays: ["wss://a"] });
  Cfg.save(c);
  let subscriptions = 0;
  let deliver: ((ev: any) => void) | null = null, onClose: (() => void) | null = null;
  const pool: Pool = {
    publish() { return [Promise.resolve()]; },
    subscribe(_r, _f, cb) { subscriptions++; deliver = cb.onevent; onClose = () => cb.onclose?.(["bye"]); return { close() { deliver = null; } }; },
  };
  const atB: T.Msg[] = [];
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], { onMessage: async (_t, m) => { atB.push(m); }, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {} }, pool);
  B.listen();
  expect(subscriptions).toBe(1);
  const t: T.Thread = { id: "nx1", subject: "x", from: { sessionId: `nostr:${a.pk}`, name: "Ana", cwd: "(otra)" }, to: { sessionId: `nostr:${b.pk}`, name: "yo", cwd: "(esta)" }, state: "open", createdAt: 1, lastActivityAt: 1, context: {}, transporte: "nostr", nostr: { otro: a.pk, relays: ["wss://a"], enviados: [] }, messages: [] };
  T.save(t);
  deliver!(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nx1", kind: "msg" }, "one").wrap);
  await sleep(50);
  expect(atB.length).toBe(1);
  // It gets closed (as the daemon does when reloading the config) and the relay reports the close.
  B.close();
  onClose!();
  B.listen();
  expect(subscriptions).toBe(1);
  expect(deliver).toBeNull();
});

/**
 * A chunk bigger than a chunk.
 *
 * `f.total` and `f.size` are declared by the sender and are checked, but the bytes that
 * actually arrive were not looked at: they were decoded whole in memory and written to
 * disk, and only afterwards was the rebuilt file's size compared. Measured with a single
 * envelope with total=1: 3 MB written with CHUNK at 20 KB. The real limit was set by the
 * relay, that is, nobody if the relay belongs to the sender.
 */
test("a chunk bigger than CHUNK does not touch the disk", async () => {
  const { CHUNK } = await import("../src/nostr.ts");
  const { SPOOL } = await import("../src/files.ts");
  const { existsSync, readFileSync } = await import("node:fs");
  const a = keys(), b = keys();
  const c = Cfg.load();
  Cfg.addContact(c, { id: "nostr:gordo", name: "Ana", npub: a.pk } as any);
  Cfg.save(c);
  const inbound = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], { onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {} }, inbound.pool);
  B.listen();
  const fat = Buffer.alloc(CHUNK * 4, 0x41);
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "ngordo", kind: "file", file: { fid: "fg", n: 0, total: 1, name: "x.bin", size: fat.length } }, fat.toString("base64")).wrap);
  await sleep(80);
  expect(existsSync(join(SPOOL, "ngordo"))).toBe(false);
  // And one of the right size through the same door does get in.
  const fits = Buffer.alloc(CHUNK, 0x42);
  inbound.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "ncabe", kind: "file", file: { fid: "fc", n: 0, total: 1, name: "y.bin", size: fits.length } }, fits.toString("base64")).wrap);
  await hasta(() => existsSync(join(SPOOL, "ncabe", "fc-y.bin")));
  expect(readFileSync(join(SPOOL, "ncabe", "fc-y.bin")).equals(fits)).toBe(true);
});

/**
 * The join hello does not stay on one relay.
 *
 * `hola` returned with Promise.any, at the first relay that accepted, and `join` destroys
 * the pool right after: the other publishes got cut off halfway. Measured on the real
 * relays on 14-09 with Adrian's join: damus nothing, nos.lol the hello, primal nothing. If
 * the one holding it is exactly the one the other daemon is not listening to, the join
 * never arrives.
 */
test("hola waits for every relay before returning, not just the first", async () => {
  const a = keys(), b = keys();
  const published: string[] = [];
  const pool: Pool = {
    publish: () => [
      Promise.resolve().then(() => { published.push("fast"); }),
      sleep(300).then(() => { published.push("slow"); }),
    ],
    subscribe: () => ({ close() {} }),
  };
  const bridge = new NostrBridge(a.sk, a.pk, ["wss://fast", "wss://slow"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {},
  }, pool);
  expect(await bridge.hello(b.pk, [], "Adrian")).toBe(true);
  // What `join` does right after hola: close. Whatever has not gone out by then never will.
  const onReturn = [...published];
  bridge.close();
  expect(onReturn.sort()).toEqual(["fast", "slow"]);
});

test("hola counts the hello as good if it reaches one relay, even if another fails or does not answer", async () => {
  const a = keys(), b = keys();
  const pool: Pool = {
    publish: () => [Promise.resolve(), Promise.reject(new Error("relay down")), new Promise(() => {})],
    subscribe: () => ({ close() {} }),
  };
  const bridge = new NostrBridge(a.sk, a.pk, ["wss://a", "wss://b", "wss://c"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {},
  }, pool, { esperaPublicarMs: 200 });
  const t0 = Date.now();
  expect(await bridge.hello(b.pk, [], "Adrian")).toBe(true);
  // The one that does not answer does not hang the join.
  expect(Date.now() - t0).toBeLessThan(2000);
  bridge.close();
});

/**
 * Someone not in my contacts is not left talking to themselves.
 *
 * Their invite was dropped with one line in my log and nothing else: their side said
 * "delivered over Nostr, pending" and waited for an answer that was never coming. That is
 * what happened on 14-09 with a real join, and the complaint was, word for word: "it told
 * me it had opened one but I got no notification or anything".
 *
 * The answer is a `close` to that id, which every version since 0.9 can read: their
 * spoochie closes and their Claude tells them why. The text is fixed, repeats nothing of
 * theirs, and goes out at most once a day per key, so my daemon is nobody's loudspeaker.
 */
test("an invite from a key not in the contacts is answered by closing it, once", async () => {
  const b = keys(), x = keys();
  const c = Cfg.load(); c.human = "Edu"; Cfg.save(c);
  const { pool, published, inject } = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {},
  }, pool);
  B.listen();

  inject(wrapEnvelope(x.sk, b.pk, { v: 1, id: "nd1", kind: "invite", subject: "the playbook", fromName: "Adrian" }, "explain it to me").wrap);
  await sleep(50);
  expect(T.load("nd1")).toBeNull();
  expect(published).toHaveLength(1);
  const r = open(published[0], x.sk)!;
  expect(r.from).toBe(b.pk);
  expect(r.envelope.kind).toBe("close");
  expect(r.envelope.id).toBe("nd1");
  expect(r.text).toContain("Edu does not have you in their spoochie contacts");
  // Nothing of what they sent comes back in the answer.
  expect(r.text).not.toContain("playbook");
  expect(r.text).not.toContain("Adrian");
  // It fits whole in the close reason the other side accepts.
  expect(T.outsideReason(r.text)).toBe(r.text);

  // Another invite from the same key the same day: not answered again.
  inject(wrapEnvelope(x.sk, b.pk, { v: 1, id: "nd2", kind: "invite", subject: "another" }, "another").wrap);
  // Nor a loose message: there is no spoochie of theirs to close.
  inject(wrapEnvelope(keys().sk, b.pk, { v: 1, id: "nd3", kind: "msg" }, "hello?").wrap);
  await sleep(50);
  expect(published).toHaveLength(1);
  B.close();
});

test("and that close reaches whoever opened: their spoochie closes with the reason", async () => {
  const a = keys(), b = keys();
  const c = Cfg.load(); c.human = "Edu";
  Cfg.addContact(c, { id: "U_EDU_ND", name: "Edu", npub: b.pk, relays: ["wss://b"] });
  Cfg.save(c);
  const tA: T.Thread = { id: "nd4", subject: "the playbook", from: { sessionId: "A1", name: "a", cwd: "/a" }, to: { sessionId: `nostr:${b.pk}`, name: "Edu", cwd: "(otra)" }, state: "pending", createdAt: 1, lastActivityAt: 1, context: {}, transporte: "nostr", nostr: { otro: b.pk, relays: ["wss://b"], enviados: [] }, messages: [] };
  T.save(tA);

  // B does not have A in its contacts: it answers by closing.
  const fromB = memoryPool();
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], { onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {} }, fromB.pool);
  B.listen();
  fromB.inject(wrapEnvelope(a.sk, b.pk, { v: 1, id: "nd4", kind: "invite", subject: "the playbook" }, "explain it to me").wrap);
  await sleep(50);
  expect(fromB.published).toHaveLength(1);

  const closes: string[] = [];
  const fromA = memoryPool();
  const A = new NostrBridge(a.sk, a.pk, ["wss://a"], { onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async (_t, m) => { closes.push(m); }, onHello: async () => {}, log: () => {} }, fromA.pool);
  A.listen();
  fromA.inject(fromB.published[0]);
  await sleep(50);
  expect(closes).toHaveLength(1);
  expect(closes[0]).toContain("does not have you in their spoochie contacts");
  A.close(); B.close();
});
