import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The two envelopes that do something on their own: `accept` and `close`.
 *
 * The rest of a thread is read by a person. Not these two: `accept` opens the tunnel and launches
 * the aside Claude, and `close` closes the spoochie and purges whatever it kept. They were
 * handled BEFORE checking the signature, and over Slack both sides post with the same bot
 * token, so whoever had that token could open or close tunnels posing as
 * the other person. That's exactly the attacker the signature exists for, and it's
 * written that way in docs/PROTOCOL.md.
 *
 * Measured before touching anything, with `pollThread` and a fake Slack: an envelope without `sig`
 * or `pk` with someone else's `from` gave accepted=true with kind=accept and closed the thread with
 * kind=close.
 */
// tests/setup.ts sets HOME before anyone imports paths.ts, and ROOT is
// computed once on import. Setting another SPOOCHIE_HOME here doesn't move ROOT: it only
// leaves the config written where nobody reads it. It's written to the ROOT that already exists.
let HOME = "";

let SlackBridge: any, EVENT: string, T: any, sign: any, newKeys: any, Cfg: any;

const OTHER = "U_OTHER", ME = "U_ME", NO_KEY = "U_BEA";
let otherKey: { pub: string; priv: string };

beforeAll(async () => {
  HOME = (await import("../src/paths.ts")).ROOT;
  mkdirSync(join(HOME, "threads"), { recursive: true, mode: 0o700 });
  ({ newKeys, makeSignature: sign } = await import("../src/signing.ts"));
  otherKey = newKeys();
  writeFileSync(join(HOME, "config.json"), JSON.stringify({
    guardian: false, transcript: false, aparte: false, human: "Edu",
    slack: { userId: ME, botToken: "xoxb-fake" },
    // The other side is in the contacts with its key already pinned: the normal case.
    contacts: {
      ana: { id: OTHER, name: "Ana", pk: otherKey.pub },
      // Bea is in the contacts but has never signed anything: I have no key of hers.
      bea: { id: NO_KEY, name: "Bea" },
    },
  }), { mode: 0o600 });
  ({ SlackBridge, EVENT } = await import("../src/slack.ts"));
  T = await import("../src/threads.ts");
  Cfg = await import("../src/config.ts");
});

/** A bridge with a fake Slack, and what reaches it from the thread. */
function bridge(reply: any) {
  const seen = { accepted: false, closed: "", notices: [] as string[] };
  const b = SlackBridge.fromConfig(
    async () => {}, async () => {}, async () => { seen.accepted = true; },
  )!;
  b.onCierre = async (_t: any, m: string) => { seen.closed = m; };
  b.get = async (m: string) => m === "conversations.replies" ? { ok: true, messages: [reply] } : { ok: true };
  b.call = async (_m: string, body: any) => { seen.notices.push(String(body?.text ?? "")); return { ok: true, ts: "9.0" }; };
  return { b, seen };
}

function thread(id: string) {
  const t: any = {
    id, subject: "s", state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: `slack:${OTHER}`, name: "Ana", cwd: "(other)", human: "Ana", slackUser: OTHER },
    to: { sessionId: `slack:${ME}`, name: "me", cwd: "(this)", slackUser: ME },
    context: {}, messages: [], slack: { channel: "C1", ts: "1.0" },
  };
  T.save(t);
  return t;
}

// "cerrado (" is how a 0.9.10 peer writes a close: the receiver reads the reason from it.
const TEXT = "cerrado (by Ana)";
const envelope = (id: string, kind: string, extra: any = {}) => ({
  ts: "2.0", text: TEXT,
  metadata: { event_type: EVENT, event_payload: { v: 1, id, kind, from: OTHER, fromName: "Ana", ...extra } },
});
/** Signed the way the real sender signs: over the body the receiver rebuilds. */
function signed(id: string, kind: string) {
  const env: any = { v: 1, id, kind, from: OTHER, to: ME, ts: Math.floor(Date.now() / 1000), sv: 2, app: "0.9.9", pk: otherKey.pub };
  env.sig = sign(otherKey.priv, env, TEXT);
  return envelope(id, kind, env);
}

test("an unsigned accept from someone with a pinned key doesn't open the tunnel", async () => {
  thread("s1");
  const { b, seen } = bridge(envelope("s1", "accept"));
  await b.pollThread(T.load("s1"));
  expect(seen.accepted).toBe(false);
  expect(seen.notices.join(" ")).toContain("Dropped");
});

/**
 * The case that really opens the hole. An unsigned envelope from an id I have no
 * key for is DELIVERED, marked unsigned: that's the rule written in docs/PROTOCOL.md, and
 * for a message it's fine, because whoever reads it is a person who sees the mark. Nobody
 * reads an `accept`. Here "not rejected" isn't enough: it needs a signature.
 */
test("nor does an unsigned accept from someone without a pinned key, even though a message of theirs would get in", async () => {
  const t: any = thread("s1b");
  t.from = { sessionId: `slack:${NO_KEY}`, name: "Bea", cwd: "(other)", human: "Bea", slackUser: NO_KEY };
  T.save(t);
  const rep = envelope("s1b", "accept");
  rep.metadata.event_payload.from = NO_KEY;
  const { b, seen } = bridge(rep);
  await b.pollThread(T.load("s1b"));
  expect(seen.accepted).toBe(false);
  expect(seen.notices.join(" ")).toContain("came unsigned");
});

test("an unsigned close neither closes nor purges the thread", async () => {
  thread("s2");
  const { b, seen } = bridge(envelope("s2", "close"));
  await b.pollThread(T.load("s2"));
  expect(seen.closed).toBe("");
  expect(T.load("s2").state).toBe("pending");
});

test("a signature that isn't from that key doesn't count either", async () => {
  thread("s3");
  const wrong = newKeys();
  const env: any = { v: 1, id: "s3", kind: "accept", from: OTHER, to: ME, ts: Math.floor(Date.now() / 1000), sv: 2, pk: otherKey.pub };
  env.sig = sign(wrong.priv, env, TEXT);   // signed with a key that isn't theirs
  const { b, seen } = bridge(envelope("s3", "accept", env));
  await b.pollThread(T.load("s3"));
  expect(seen.accepted).toBe(false);
});

test("and the really signed accept does open the tunnel", async () => {
  thread("s4");
  const { b, seen } = bridge(signed("s4", "accept"));
  await b.pollThread(T.load("s4"));
  expect(seen.accepted).toBe(true);
});

test("and the really signed close does close", async () => {
  thread("s5");
  const { b, seen } = bridge(signed("s5", "close"));
  await b.pollThread(T.load("s5"));
  expect(seen.closed).toBe("by Ana");
});

/**
 * A v1 signature isn't enough to open or close.
 *
 * It signs neither the time nor the recipient, so an envelope of theirs is valid forever and in
 * any thread. And it breaks compatibility with nobody: checked in the 0.9.8 tree,
 * `post` only signed the invite and the messages, never an accept or a close.
 */
test("a v1 signature doesn't open the tunnel even if it's valid", async () => {
  const { makeSignatureV1 } = await import("../src/signing.ts");
  thread("s6");
  const env: any = { v: 1, id: "s6", kind: "accept", from: OTHER, fromName: "Ana", pk: otherKey.pub };
  env.sig = makeSignatureV1(otherKey.priv, "s6", "accept", OTHER, TEXT);
  const { b, seen } = bridge(envelope("s6", "accept", env));
  await b.pollThread(T.load("s6"));
  expect(seen.accepted).toBe(false);
});
