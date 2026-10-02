import { expect, test } from "bun:test";
import { SlackBridge, envelopeOf, inviteBlocks, messageBlocks, noFences, noticeBlocks, fallbackText, chunk, isAck, bodyFromBlocks, discoveryCadence, EVENT, type Envelope } from "../src/slack.ts";
import { MAX_PATCH } from "../src/threads.ts";
import type { Thread, Msg } from "../src/threads.ts";

const t: Thread = {
  id: "a3f1", subject: "the modal closes when you press Save",
  from: { sessionId: "A", name: "a", cwd: "/a", human: "Edu", slackUser: "U_EDU" },
  to: { sessionId: "B", name: "b", cwd: "/b", human: "Sam", slackUser: "U_SAM" },
  state: "open", createdAt: 0, lastActivityAt: 0,
  context: { branch: "feat/perfil", sha: "cafe12345678", files: ["src/Modal.tsx"] },
  messages: [{ at: 0, from: "A", author: "claude", kind: "text", text: "it closes before the POST" }],
};
const msg = (o: Partial<Msg>): Msg => ({ at: 0, from: "A", author: "claude", kind: "text", text: "x", ...o });
const flat = (b: unknown[]) => JSON.stringify(b);

test("the machine envelope is recognized by event_type and payload", () => {
  const env: Envelope = { v: 1, id: "a3f1", kind: "msg", from: "U_EDU" };
  expect(envelopeOf({ metadata: { event_type: EVENT, event_payload: env } })).toEqual(env);
});

test("a message typed by hand in Slack has no envelope", () => {
  expect(envelopeOf({ text: "hello" })).toBeNull();
  expect(envelopeOf({ metadata: { event_type: "something_else", event_payload: { id: "x", from: "y" } } })).toBeNull();
});

test("the invite mentions the receiver and says how to accept", () => {
  const b = flat(inviteBlocks(t));
  expect(b).toContain("<@U_SAM>");
  expect(b).toContain("spoochie accept a3f1");
  // The same voice as the macOS dialog: who is calling, not whose spoochie it is.
  expect(b).toContain("Edu is calling");
  expect(b).toContain("feat/perfil");
  expect(b).toContain("src/Modal.tsx");
});

test("the Slack layer does not carry the receiver's internal instructions", () => {
  const b = flat(messageBlocks(t, msg({ text: "the catch does not reset the state" })));
  expect(b).toContain("the catch does not reset the state");
  expect(b).not.toContain("Do not apply changes");
  expect(b).not.toContain("spoochie say");
});

test("what the person says is told apart from what their Claude says", () => {
  expect(flat(messageBlocks(t, msg({ author: "human" })))).toContain("in person");
  expect(flat(messageBlocks(t, msg({ author: "claude" })))).toContain("their Claude");
});

test("the watcher notice also shows in Slack, without hiding the message", () => {
  const b = flat(messageBlocks(t, msg({ text: "where do we eat", offTopic: { verdict: "fuera", why: "food" } })));
  expect(b).toContain("where do we eat");
  expect(b).toContain("off topic");
  expect(flat(messageBlocks(t, msg({ offTopic: { verdict: "dentro", why: "" } })))).not.toContain("watcher");
});

test("a patch goes in a code block and warns that nobody applies it for you", () => {
  const b = flat(messageBlocks(t, msg({ kind: "patch", text: "--- a\n+++ b\n-x\n+y" })));
  expect(b).toContain("```");
  expect(b).toContain("nobody writes to your machine");
  expect(b).toContain("+y");
});

test("system notices do not drag internal text into Slack", () => {
  const acc = noticeBlocks({ ...t, acceptedBy: "Sam" }, '[spoochie a3f1] b accepted the tunnel.\nYou can talk now: spoochie say a3f1 "<text>"');
  expect(acc.text).toContain("Sam");
  expect(acc.text).not.toContain("spoochie say");
  expect(acc.text).not.toContain("<text>");
  const cl = noticeBlocks({ ...t, closeReason: "resolved" }, "[spoochie a3f1 | s] closed (resolved).");
  expect(cl.text).toContain("resolved");
  expect(cl.text).not.toContain("[spoochie");
});

test("an accept or close rendered by 0.9.10, in Spanish, still goes out as an accept or close", async () => {
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "chat.postMessage") posts.push(body); return { ts: "1.0" }; };
  b.pensandoOff = async () => {};
  const th = { ...t, slack: { channel: "G1", ts: "0.1" }, closeReason: "resolved" };
  for (const notice of ["[spoochie a3f1 | s] Sam accepted the tunnel.", "[spoochie a3f1 | s] Sam ha aceptado el tunel.", "[spoochie a3f1 | s] closed (resolved).", "[spoochie a3f1 | s] cerrado (resolved)."]) await b.post(th, notice);
  expect(posts.map(p => p.metadata.event_payload.kind)).toEqual(["accept", "accept", "close", "close"]);
});

test("the fallback text is what shows in the phone notification", () => {
  expect(fallbackText(t, msg({ text: "the catch does not reset" }))).toBe("Edu: the catch does not reset");
  expect(fallbackText(t, msg({ kind: "patch", text: "diff" }))).toContain("patch");
});

test("blocks respect Slack's 3000-character limit by splitting", () => {
  const long = "x".repeat(9000);
  const blocks = messageBlocks(t, msg({ text: long })) as any[];
  for (const b of blocks) {
    const txt = b.text?.text ?? b.elements?.[0]?.text ?? "";
    expect(txt.length).toBeLessThanOrEqual(3000);
  }
  // And nothing is lost on the way.
  const total = blocks.map(b => b.text?.text ?? "").join("").length;
  expect(total).toBeGreaterThanOrEqual(9000);
});

test("a long message is not cut mid-word", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i} with enough text to fill it up`).join("\n");
  const pieces = chunk(long);
  for (const c of pieces) expect(c.length).toBeLessThanOrEqual(2800);
  // Nothing is split inside a line while it fits.
  expect(pieces.join("\n").startsWith("line 0 with enough text")).toBe(true);
});

test("a line longer than a block is split, not dropped", () => {
  const pieces = chunk("x".repeat(7000));
  expect(pieces.join("").length).toBe(7000);
});

test("the text travels in the blocks and comes back whole, without the envelope", () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  // fallbackText is short on purpose: it is the phone notification, not the content.
  expect(fallbackText(t, msg({ text: long })).length).toBeLessThan(300);
  // What the daemon on the other side reads is the marked blocks.
  const blocks = messageBlocks(t, msg({ text: long }));
  expect(bodyFromBlocks(blocks as any)).toBe(long);
});

test("only content blocks count: the signature and notices do not", () => {
  const blocks = messageBlocks(t, msg({ text: "the catch does not reset", offTopic: { verdict: "fuera", why: "x" } }));
  const body = bodyFromBlocks(blocks as any);
  expect(body).toBe("the catch does not reset");
  expect(body).not.toContain("their Claude");
  expect(body).not.toContain("watcher");
});

test("the invite is also rebuilt from its blocks", () => {
  expect(bodyFromBlocks(inviteBlocks(t) as any)).toBe("it closes before the POST");
});

test("a bare ack is accepting, not a conversation turn", () => {
  // The Spanish words stay: 0.9.10 users and Spanish speakers still type them.
  for (const s of ["acepto", "Acepto.", "vale", "ok", "dale", "👍", " sí "]) expect(isAck(s)).toBe(true);
  for (const s of ["okay", "Sure!", "yes", "got it", "Thanks.", "accept"]) expect(isAck(s)).toBe(true);
  for (const s of ["acepto, pero mira antes el toaster", "ok el hook devuelve promesa", "vale la pena revisarlo"])
    expect(isAck(s)).toBe(false);
  for (const s of ["ok but check the toaster first", "yes the hook returns a promise", "thanks, one more thing"])
    expect(isAck(s)).toBe(false);
});

test("Slack mrkdwn is undone: code that looked like a URL is code again", () => {
  const blocks = [
    { type: "section", block_id: "sp-body-0-1", text: { type: "mrkdwn", text: "await <http://api.post|api.post>('/profile')" } },
    { type: "section", block_id: "sp-body-1-1", text: { type: "mrkdwn", text: "if (a &lt; b &amp;&amp; c &gt; d) {}" } },
  ];
  const body = bodyFromBlocks(blocks as any);
  expect(body).toContain("await api.post('/profile')");
  expect(body).toContain("if (a < b && c > d) {}");
  expect(body).not.toContain("http://");
});

test("a team of 15 fits within Slack's limit", () => {
  // Read the real constants, not the file text: if someone raises the cap or speeds up
  // discovery, the math has to come out wrong here.
  const B = SlackBridge as any;
  const cap: number = B.MAX_THREADS;

  // The Tier 3 limit is ~50/min per method and PER APP, so the whole team shares it.
  const LIMIT = 50;
  const team = 15, active = 2;
  const perMinute = (everyMs: number) => 60_000 / everyMs;

  // conversations.history: one per discovery round per person, at the cadence a team
  // of 15 gets. All 15 daemons discover at once, with or without a conversation.
  const history = team * perMinute(discoveryCadence(team));
  // conversations.replies: one tick every 4 s looking at most at MAX_THREADS threads,
  // but a two-person conversation has only one live thread per side.
  const replies = active * Math.min(1, cap) * perMinute(4_000);

  expect(history).toBeLessThan(LIMIT);
  expect(replies).toBeLessThan(LIMIT);
  expect(cap).toBeLessThanOrEqual(4);
});

test("a patch that fits is not cut on the way", () => {
  const line = "+ const x = 1;";
  const diff = Array(Math.floor(MAX_PATCH / (line.length + 1))).fill(line).join("\n");
  const t = { id: "p1", subject: "x", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, state: "open", createdAt: 0, lastActivityAt: 0, context: {}, messages: [] } as any as Thread;
  const blocks = messageBlocks(t, { at: 0, from: "A", author: "claude", kind: "patch", text: diff });
  const text = JSON.stringify(blocks);
  // The cut-off note only shows if something was left out, and what fits is not left out.
  expect(text).not.toContain("continued in the transcript");
});

test("the inbox is checked as often as the app quota allows for the real team", async () => {
  const { discoveryCadence } = await import("../src/slack.ts");
  expect(discoveryCadence(1)).toBe(5_000);
  expect(discoveryCadence(2)).toBe(5_000);
  expect(discoveryCadence(4)).toBe(9_600);
  expect(discoveryCadence(15)).toBe(36_000);
  expect(discoveryCadence(25)).toBe(60_000);
  // 25 daemons at that cadence spend 25 calls per minute, half the quota.
  expect(Math.round(25 * 60_000 / discoveryCadence(25))).toBe(25);
});

test("an envelope whose id is not an id is not an envelope", () => {
  const msg = (id: string) => ({ metadata: { event_type: EVENT, event_payload: { id, from: "U1", kind: "invite" } } });
  expect(envelopeOf(msg("../settings"))).toBeNull();
  expect(envelopeOf(msg("a/b"))).toBeNull();
  expect(envelopeOf(msg("x".repeat(40)))).toBeNull();
  expect(envelopeOf(msg("e856"))).not.toBeNull();
});

function openingBridge(groupFails = false) {
  const calls: { method: string; body: any }[] = [];
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  b.call = async (method: string, body: any) => {
    calls.push({ method, body });
    if (method === "conversations.open") {
      const users = String(body.users);
      if (users.includes(",")) { if (groupFails) throw new Error("slack conversations.open: missing_scope"); return { channel: { id: "G_GROUP" } }; }
      return { channel: { id: "D_SAM" } };
    }
    if (method === "chat.postMessage") return { ts: body.channel === "G_GROUP" ? "200.000" : "201.000" };
    if (method === "chat.getPermalink") return { permalink: "https://x.slack.com/archives/G_GROUP/p200000" };
    return {};
  };
  return { b, calls };
}

test("the thread of a spoochie I open goes to a group we both see, and the receiver's DM gets the notice with the pointer", async () => {
  const Cfg = await import("../src/config.ts");
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_EDU", pollMs: 4000, hilos: "grupo" } } as any);
  const { b, calls } = openingBridge();
  const r = await b.openThread(t);
  // And where the DM notice landed is saved, so it can be deleted on close.
  expect(r).toEqual({ channel: "G_GROUP", ts: "200.000", aviso: { channel: "D_SAM", ts: "201.000" } });
  const opened = calls.filter(l => l.method === "conversations.open").map(l => l.body.users);
  expect(opened).toContain("U_SAM");
  expect(opened).toContain("U_EDU,U_SAM");
  const posts = calls.filter(l => l.method === "chat.postMessage");
  expect(posts.map(p => p.body.channel)).toEqual(["G_GROUP", "D_SAM"]);
  // The DM notice carries the full envelope and where the thread is; the group one does not.
  expect(posts[0].body.metadata.event_payload.thread).toBeUndefined();
  expect(posts[1].body.metadata.event_payload.thread).toEqual({ channel: "G_GROUP", ts: "200.000" });
  expect(flat(posts[1].body.blocks)).toContain("The conversation continues in");
  // And the receiver materializes the thread in the group, not in its DM.
  const env = envelopeOf({ metadata: { event_type: EVENT, event_payload: posts[1].body.metadata.event_payload } })!;
  expect(env.thread!.channel).toBe("G_GROUP");
});

test("without group permissions, the thread stays in the receiver's DM, as before", async () => {
  const Cfg = await import("../src/config.ts");
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_EDU", pollMs: 4000, hilos: "grupo" } } as any);
  const { b, calls } = openingBridge(true);
  const r = await b.openThread(t);
  expect(r).toEqual({ channel: "D_SAM", ts: "201.000" });
  expect(calls.filter(l => l.method === "chat.postMessage").length).toBe(1);
});

test("with --hilos canal, the thread goes to the channel and the notice to the DM", async () => {
  const Cfg = await import("../src/config.ts");
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_EDU", pollMs: 4000, hilos: "canal", canal: "C_SPOOCHIE" } } as any);
  const { b, calls } = openingBridge();
  const r = await b.openThread(t);
  expect(r.channel).toBe("C_SPOOCHIE");
  expect(calls.filter(l => l.method === "chat.postMessage").map(l => l.body.channel)).toEqual(["C_SPOOCHIE", "D_SAM"]);
  Cfg.save({ guardian: false, transcript: false } as any);
});

/**
 * A `close` signed the way the real sender signs it. Since 0.9.9 an unsigned close closes
 * nothing: it is the one thing you can post with the bot token that erases someone
 * else's thread. The contact is left with their key pinned, which is the normal case.
 */
function signedClose(id: string, from: string, text: string) {
  const { newKeys, makeSignature } = require("../src/signing.ts");
  const Cfg = require("../src/config.ts");
  const k = newKeys();
  const c = Cfg.load();
  Cfg.addContact(c, { id: from, name: "Edu", pk: k.pub });
  Cfg.save(c);
  const env: any = { v: 1, id, kind: "close", from, ts: Math.floor(Date.now() / 1000), sv: 2, pk: k.pub };
  env.sig = makeSignature(k.priv, env, text);
  return env;
}

test("the close travels with its own kind and the other side closes on reading it", async () => {
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "chat.postMessage") posts.push(body); return { ts: "1.0" }; };
  b.pensandoOff = async () => {};
  await b.post({ ...t, slack: { channel: "G1", ts: "0.1" }, closeReason: "resolved" }, "[spoochie a3f1 | s] cerrado (resolved). The tunnel no longer delivers messages.");
  expect(posts[0].metadata.event_payload.kind).toBe("close");

  // On the other side: the "close" envelope calls onCierre with the reason, and is not delivered as a turn.
  const delivered: any[] = [];
  const closed: string[] = [];
  const r: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_SAM", async (_t: any, m: any) => { delivered.push(m); }, async () => {}, async () => {});
  r.onCierre = async (_t: any, reason: string) => { closed.push(reason); };
  r.get = async () => ({ messages: [
    { ts: "0.1", user: "UBOT", text: "root" },
    { ts: "0.2", user: "UBOT", bot_id: "B1", text: "[spoochie a3f1 | s] cerrado (resolved). x", metadata: { event_type: EVENT, event_payload: signedClose("a3f1", "U_EDU", "[spoochie a3f1 | s] cerrado (resolved). x") } },
  ] });
  const thread = { ...t, slack: { channel: "G1", ts: "0.1" } };
  const Tm = await import("../src/threads.ts"); Tm.save(thread as any);
  await r.pollThread(Tm.load("a3f1"));
  expect(closed).toEqual(["resolved"]);
  expect(delivered).toEqual([]);
});

test("a branch sent over Slack carries a signature that matches what the receiver rebuilds", async () => {
  // The receiver checks the signature against the text it rebuilds from the body blocks.
  // Up to 0.9.10 the sender signed m.text, and a branch body also carries its label, so
  // every branch arrived as "carried a signature that is not theirs" and was dropped.
  const { checkSignature } = require("../src/signing.ts");
  const Cfg = require("../src/config.ts");
  const c = Cfg.load(); c.slack = { ...(c.slack ?? {}), userId: "U_EDU" }; Cfg.save(c);
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "chat.postMessage") posts.push(body); return { ts: "1.0" }; };
  b.pensandoOff = async () => {};
  const m = msg({ kind: "branch", text: "feat/profile" });
  await b.post({ ...t, slack: { channel: "G1", ts: "0.1" } }, "", m);
  const env = posts[0].metadata.event_payload;
  expect(env.sig).toBeTruthy();
  expect(checkSignature(env.pk, env, bodyFromBlocks(posts[0].blocks), env.sig)).toBe(true);
});

test("the close reason reaches the other side as the sender posts it", async () => {
  // The receiver read the reason with /cerrado \((.*)\)/ from the posted text, but what is
  // posted is ":lock: Closed · <reason>" (":lock: Cerrado · <reason>" in 0.9.10), so the
  // other side always saw "closed by the other side".
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "chat.postMessage") posts.push(body); return { ts: "1.0" }; };
  b.pensandoOff = async () => {};
  await b.post({ ...t, id: "c10s", slack: { channel: "G1", ts: "0.1" }, closeReason: "fixed in main" }, "[spoochie c10s | s] closed (fixed in main).");
  const Tm = await import("../src/threads.ts");
  for (const text of [posts[0].text, ":lock: Cerrado · fixed in main"]) {
    const closed: string[] = [];
    const r: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_SAM", async () => {}, async () => {}, async () => {});
    r.onCierre = async (_t: any, reason: string) => { closed.push(reason); };
    r.get = async () => ({ messages: [
      { ts: "0.1", user: "UBOT", text: "root" },
      { ts: "0.2", user: "UBOT", bot_id: "B1", text, metadata: { event_type: EVENT, event_payload: signedClose("c10s", "U_EDU", text) } },
    ] });
    Tm.save({ ...t, id: "c10s", slack: { channel: "G1", ts: "0.1" } } as any);
    await r.pollThread(Tm.load("c10s"));
    expect(closed).toEqual(["fixed in main"]);
  }
});

test("borrarHilo deletes what the bot posted (messages, files, root and notice) and leaves what a person wrote", async () => {
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  b.botUserId = "UBOT";
  const deleted: string[] = [];
  b.get = async () => ({ messages: [
    { ts: "0.1", user: "UBOT", bot_id: "B1", text: "root" },
    { ts: "0.2", user: "UBOT", bot_id: "B1", text: "from the bot", files: [{ id: "F1" }] },
    { ts: "0.3", user: "U_SAM", text: "typed by hand" },
    { ts: "0.4", bot_id: "B1", text: "from the bot again" },
  ] });
  b.call = async (method: string, body: any) => { deleted.push(`${method}:${body.ts ?? body.file}`); return {}; };
  const n = await b.borrarHilo({ ...t, slack: { channel: "G1", ts: "0.1", aviso: { channel: "D_SAM", ts: "9.9" } } });
  expect(deleted).toEqual(["files.delete:F1", "chat.delete:0.2", "chat.delete:0.4", "chat.delete:0.1", "chat.delete:9.9"]);
  expect(n).toBe(4);
});

test("a hola over Slack brings the other side's Nostr key and lands in contacts; mine carries mine", async () => {
  const b: any = new (SlackBridge as any)("xoxp-fake", "xoxb-fake", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "conversations.open") return { channel: { id: "D_X" } }; if (method === "chat.postMessage") posts.push(body); return {}; };
  await b.hola("U_SAM", "a".repeat(64), ["wss://x"], "Edu");
  expect(posts[0].channel).toBe("D_X");
  expect(posts[0].metadata.event_payload).toMatchObject({ kind: "hola", np: "a".repeat(64), r: ["wss://x"], fromName: "Edu" });
  // It is signed with my ed25519 key: without that, anyone with the bot token puts a key in my name.
  // Since 0.9.9 the signature also binds who it is for, when it was signed and which version.
  const { checkSignature } = await import("../src/signing.ts");
  const p = posts[0].metadata.event_payload;
  expect(p.sv).toBe(2);
  expect(p.to).toBe("U_SAM");
  expect(p.ts).toBeGreaterThan(0);
  expect(checkSignature(p.pk, p, p.np, p.sig)).toBe(true);
  // And changing who it was for breaks it.
  expect(checkSignature(p.pk, { ...p, to: "U_OTHER" }, p.np, p.sig)).toBe(false);
  expect(checkSignature(p.pk, "hola", "hola", "U_EDU", "b".repeat(64), p.sig)).toBe(false);

  const received: any[] = [];
  b.onHola = async (from: string, name: string, np: string, r: string[], verdict: string) => { received.push({ from, name, np, r, verdict }); };
  b.inbox = async () => "D_ME";
  b.get = async () => ({ messages: [
    { ts: "5.0", metadata: { event_type: EVENT, event_payload: { v: 1, id: "hola", kind: "hola", from: "U_SAM", fromName: "Sam", np: "b".repeat(64), r: ["wss://sam"] } } },
    { ts: "5.0", metadata: { event_type: EVENT, event_payload: { v: 1, id: "hola", kind: "hola", from: "U_SAM", fromName: "Sam", np: "b".repeat(64), r: ["wss://sam"] } } },
  ] });
  b.inboxCursor = "0";
  await b.discover();
  expect(received).toEqual([{ from: "U_SAM", name: "Sam", np: "b".repeat(64), r: ["wss://sam"], verdict: "sin-firma" }]);
});

/**
 * The Slack thread is where a PERSON looks at what happened: it is what this project
 * offers as the truth. Whoever is on the other side must not be able to write in it.
 *
 * A patch renders inside a code fence, and a patch that carries ``` closes it: what
 * follows renders as normal mrkdwn. Probe: a message with a fence and then
 * ":lock: Spoochie closed" and ":white_check_mark: Sam accepted" shows up in the thread
 * exactly like the lines spoochie really draws. You could show "closed" with the tunnel
 * open, or "accepted" without anyone accepting.
 */
test("a patch cannot close the fence and fake spoochie's notices", () => {
  const poison = "hello\n```\n:lock: Spoochie closed: resolved.\n:white_check_mark: Sam accepted.\n```\nmore";
  const b = flat(messageBlocks(t, msg({ kind: "patch", text: poison })));
  // The only fences left are the two spoochie puts there.
  expect((b.match(/```/g) ?? []).length).toBe(2);
  expect(noFences("a ``` b")).toBe("a ´´´ b");
  expect(noFences("`one` and ``two``")).toBe("`one` and ``two``");
  // And a branch does not close its backticks either.
  const r = flat(messageBlocks(t, msg({ kind: "branch", text: "main` :lock: Closed `x" })));
  expect(r).not.toContain("main` :lock:");
});
