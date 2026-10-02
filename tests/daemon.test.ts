import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../src/registry.ts";
import * as Cfg from "../src/config.ts";
import * as T from "../src/threads.ts";
import { DAEMON_SOCK } from "../src/paths.ts";
import { plazo } from "./wait.ts";

/** A fake inbox: plays a Claude session and records what gets delivered to it. */
function fakeInbox(name: string) {
  const sock = join(mkdtempSync(join(tmpdir(), `sp-${name}-`)), "s.sock");
  const got: string[] = [];
  const server = net.createServer(c => {
    let buf = "";
    c.on("data", d => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const f = JSON.parse(line);
          if (f.type === "user") got.push(f.message.content);
        } catch {}
      }
    });
  });
  server.listen(sock);
  return { sock, got, server };
}

function rpc(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection({ path: DAEMON_SOCK });
    let buf = "";
    c.setTimeout(10_000, () => { c.destroy(); reject(new Error("timeout")); });
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, i))); }
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The fake inbox receives on its own socket, in this same process: the rpc can
 *  return before the 'data' event has been processed. With the whole suite in
 *  parallel that race showed up. Wait for it to arrive, with a cap. */
async function arrives(box: { got: string[] }, pred: (s: string) => boolean, ms = 3000) {
  for (let i = 0; i < ms / 25; i++) { if (box.got.some(pred)) return true; await sleep(25); }
  return box.got.some(pred);
}
const A = fakeInbox("a"), B = fakeInbox("b");
let daemon: ChildProcess;

afterAll(() => { daemon?.kill(); A.server.close(); B.server.close(); });

test("full cycle: open, approval gate, talk and close", async () => {
  // The watcher calls a model; in a test we want neither network nor cost.
  Cfg.save({ guardian: false, transcript: false, aparte: false, human: "Edu" });
  register({ sessionId: "A", name: "repo-a", cwd: "/repo/a", socket: A.sock, token: "ta", pid: process.pid, startedAt: 1 });
  register({ sessionId: "B", name: "repo-b", cwd: "/repo/b", socket: B.sock, token: "tb", pid: process.pid, startedAt: 2 });

  daemon = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, SPOOCHIE_HOME: process.env.SPOOCHIE_HOME }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  const pong = await rpc({ op: "ping" });
  expect(pong.ok).toBe(true);
  // That we're talking to THE daemon we started, not some other one already running.
  expect(pong.pid).toBe(daemon.pid!);
  expect(process.env.SPOOCHIE_HOME).toContain("spoochie-test-");

  // 1. Open: the invite reaches B and the thread is born pending.
  const open = await rpc({ op: "open", sessionId: "A", to: "repo-b", subject: "the button", body: "look at your Button" });
  expect(open.ok).toBe(true);
  expect(open.delivered).toBe(true);
  const id = open.id;
  expect(await arrives(B, x => x.includes(`spoochie accept ${id}`))).toBe(true);
  expect((await rpc({ op: "list" })).threads[0].state).toBe("pending");

  // 2. The gate: B can't answer until its human accepts.
  const early = await rpc({ op: "say", sessionId: "B", id, text: "answering without permission" });
  expect(early.ok).toBe(false);
  expect(early.error).toContain(`spoochie accept ${id}`);
  expect(A.got.length).toBe(0);

  // 3. Accept: only the receiving side can do it.
  expect((await rpc({ op: "accept", sessionId: "A", id })).ok).toBe(false);
  expect((await rpc({ op: "accept", sessionId: "B", id })).ok).toBe(true);
  expect(await arrives(A, x => x.includes("ha aceptado el tunel"))).toBe(true);

  // 4. Talk in both directions.
  expect((await rpc({ op: "say", sessionId: "B", id, text: "the wrapper is 360" })).delivered).toBe(true);
  expect(await arrives(A, x => x.includes("the wrapper is 360"))).toBe(true);
  expect((await rpc({ op: "say", sessionId: "A", id, text: "thanks, that was it" })).delivered).toBe(true);
  expect(await arrives(B, x => x.includes("thanks, that was it"))).toBe(true);

  // 5. A third party can't get in.
  expect((await rpc({ op: "say", sessionId: "C", id, text: "hello" })).ok).toBe(false);

  // 6. Close: the other side is told and delivery stops.
  expect((await rpc({ op: "close", sessionId: "A", id, reason: "resolved" })).ok).toBe(true);
  expect(await arrives(B, x => x.includes("cerrado (resolved)"))).toBe(true);
  expect((await rpc({ op: "say", sessionId: "A", id, text: "one more" })).ok).toBe(false);
}, plazo(30_000));

test("closing the screen closes your live spoochies", async () => {
  const open = await rpc({ op: "open", sessionId: "A", to: "repo-b", subject: "another", body: "hello" });
  await rpc({ op: "accept", sessionId: "B", id: open.id });
  const end = await rpc({ op: "session-end", sessionId: "A" });
  expect(end.closed).toContain(open.id);
  // By id, not by "the last message": with several live threads the order of the
  // notices isn't guaranteed and the assertion turned flaky.
  expect(B.got.some(x => x.includes(open.id) && x.includes("the other session closed"))).toBe(true);
}, plazo(20_000));

test("a remote spoochie isn't taken by the first session that starts", async () => {
  const { repoMatches } = await import("../src/match.ts");
  // With no branch in the envelope there's nothing to decide with: it isn't dealt out.
  expect(repoMatches(process.cwd(), undefined)).toBe(false);
  // A branch that doesn't exist in that checkout doesn't match either.
  expect(repoMatches(process.cwd(), "branch-that-never-exists")).toBe(false);
});

test("dealing doesn't require the other side to have your branch", async () => {
  const { repoMatches } = await import("../src/match.ts");
  // The old rule: it only went in if the branch existed in the receiver's checkout.
  // That leaves out the normal case, two people on different branches and repos.
  expect(repoMatches(process.cwd(), "feat/modal-save")).toBe(false);
  // With a single live session, that spoochie has to arrive anyway: the daemon's
  // dealing checks it, not branch matching.
});

test("several messages in a row from the same side go out as one", async () => {
  const open = await rpc({ op: "open", sessionId: "A", to: "repo-b", subject: "merge", body: "hello" });
  await rpc({ op: "accept", sessionId: "B", id: open.id });
  const before = B.got.length;
  // Between local sessions there's no merging: the socket doesn't have Slack's wall
  // of chunks problem. What's checked here is that none gets lost.
  await rpc({ op: "say", sessionId: "A", id: open.id, text: "[1] first part" });
  await rpc({ op: "say", sessionId: "A", id: open.id, text: "[2] second part" });
  expect(await arrives(B, x => x.includes("[2] second part"))).toBe(true);
  expect(B.got.length).toBe(before + 2);
  expect(await arrives(B, x => x.includes("second part"))).toBe(true);
  await rpc({ op: "close", sessionId: "A", id: open.id, reason: "done" });
}, plazo(20_000));

test("a message over the limit is rejected before going out, not truncated", async () => {
  const { MAX_MESSAGE } = await import("../src/threads.ts");
  expect(MAX_MESSAGE).toBeGreaterThan(20_000);
});

test("on close, the conversation is deleted locally and the envelope stays", async () => {
  const open = await rpc({ op: "open", sessionId: "A", to: "repo-b", subject: "deletable", body: "this must not stay" });
  await rpc({ op: "accept", sessionId: "B", id: open.id });
  await rpc({ op: "say", sessionId: "A", id: open.id, text: "nor this" });
  expect(T.load(open.id)!.messages.length).toBe(2);
  await rpc({ op: "close", sessionId: "A", id: open.id, reason: "done" });
  const t = T.load(open.id)!;
  expect(t.state).toBe("closed");
  expect(t.messages).toEqual([]);
  expect(t.borrado).toBeGreaterThan(0);
  expect(t.subject).toBe("deletable");
  expect(JSON.stringify(t)).not.toContain("this must not stay");
  // The close reached B anyway, before the deletion.
  expect(await arrives(B, x => x.includes(`[spoochie ${open.id} | deletable] cerrado (done)`))).toBe(true);
}, plazo(20_000));

test("a local send says delivered only if the inbox accepted it", async () => {
  const open = await rpc({ op: "open", sessionId: "A", to: "repo-b", subject: "fact", body: "hello" });
  await rpc({ op: "accept", sessionId: "B", id: open.id });
  const r = await rpc({ op: "say", sessionId: "A", id: open.id, text: "this really has to arrive" });
  expect(r.delivered).toBe(true);
  expect(await arrives(B, x => x.includes("this really has to arrive"))).toBe(true);
  await rpc({ op: "close", sessionId: "A", id: open.id, reason: "done" });
}, plazo(20_000));

test("an empty message doesn't go out", async () => {
  const open = await rpc({ op: "open", sessionId: "A", to: "repo-b", subject: "empty", body: "hello" });
  await rpc({ op: "accept", sessionId: "B", id: open.id });
  const before = B.got.length;
  const r = await rpc({ op: "say", sessionId: "A", id: open.id, text: "   " });
  expect(r.ok).toBe(false);
  expect(B.got.length).toBe(before);
  await rpc({ op: "close", sessionId: "A", id: open.id, reason: "done" });
}, plazo(20_000));

test("with several sessions and none matching, the whole invite goes into ONE: the most active", async () => {
  const { utimesSync } = await import("node:fs");
  const { SESSIONS_DIR } = await import("../src/paths.ts");
  // A spoochie that came over Slack, with no local side, with a branch no session has.
  const envelope = (id: string, subject: string): T.Thread => ({
    id, subject, state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_ANA", name: "Ana", cwd: "(otra maquina)", human: "Ana", slackUser: "U_ANA" },
    to: { sessionId: "slack:U_ME", name: "me", cwd: "(esta maquina)", slackUser: "U_ME" },
    context: { branch: "feat/not-in-any-checkout" },
    messages: [{ at: Date.now(), from: "slack:U_ANA", author: "claude", kind: "text", text: `the question from ${id}` }],
  });
  // A is where the person last typed: its record is the most recent.
  const now = new Date(); const before = new Date(Date.now() - 60_000);
  utimesSync(join(SESSIONS_DIR, "A.json"), now, now);
  utimesSync(join(SESSIONS_DIR, "B.json"), before, before);
  T.save(envelope("amb1", "ambiguous"));
  await rpc({ op: "claim", sessionId: "B" });
  // The full invite, with the question, in A. Nothing in B. And no "do take" line.
  expect(await arrives(A, x => x.includes("spoochie accept amb1") && x.includes("the question from amb1"))).toBe(true);
  await sleep(300);
  expect(B.got.some(x => x.includes("amb1"))).toBe(false);
  expect(A.got.some(x => x.includes("there are several sessions of yours open"))).toBe(false);
  // But it does tell it there are others, in case it wasn't this one.
  expect(A.got.some(x => x.includes("amb1") && x.includes("spoochie take amb1"))).toBe(true);

  // If the subject names a session's directory, that one wins even if it isn't the most active.
  register({ sessionId: "C", name: "modal-front", cwd: "/repo/modal-front", socket: B.sock, token: "tb", pid: process.pid, startedAt: 3 });
  utimesSync(join(SESSIONS_DIR, "C.json"), before, before);
  const b0 = B.got.length;
  T.save(envelope("amb2", "the modal-front button doesn't close"));
  await rpc({ op: "claim", sessionId: "A" });
  expect(await arrives(B, x => x.includes("spoochie accept amb2"))).toBe(true);
  expect(B.got.slice(b0).some(x => x.includes("amb2"))).toBe(true);
  expect(A.got.some(x => x.includes("amb2"))).toBe(false);
  const { unregister } = await import("../src/registry.ts");
  unregister("C");
});
