import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogText, dialogParts, osascriptScript, windowScript } from "../src/dialog.ts";
import { hasta, plazo } from "./wait.ts";

/**
 * The notice outside the terminal. Here the "dialog" is a program that gets the text and
 * answers with a button: accept unless the question says otherwise. That tests what Edu
 * asked for: the session where he works gets NOTHING, not even the invitation; accepting
 * opens the aside in his repo and the conversation goes there; declining closes the
 * tunnel.
 */
const HOME = mkdtempSync(join(tmpdir(), "spoochie-dlg-"));
const DAEMON_SOCK = join(HOME, "daemon.sock");
const RECEIVED = join(HOME, "aside-received.txt");
const NOTICES = join(HOME, "notices.txt");
const REPO = mkdtempSync(join(tmpdir(), "repo-dlg-"));

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
        try { const f = JSON.parse(line); if (f.type === "user") got.push(f.message.content); } catch {}
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
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => { buf += d.toString(); const i = buf.indexOf("\n"); if (i >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const read = (f: string) => existsSync(f) ? readFileSync(f, "utf8") : "";
const thread = (id: string) => JSON.parse(readFileSync(join(HOME, "threads", `${id}.json`), "utf8"));

const S = fakeInbox("dlg");
let daemon: ChildProcess;
afterAll(() => { daemon?.kill(); S.server.close(); });

test("the notice says who, what they want, with what context and what happens if you open it, without labels", () => {
  const t: any = { id: "d1", subject: "the button", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {}, context: { branch: "feat/x", files: ["a.ts", "b.ts"] },
    messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "look at your Button" }] };
  const { titular, cuerpo } = dialogParts(t);
  // The first thing you read is who is calling, not a lead-in.
  expect(titular).toBe("Ana is calling.");
  // The subject starts with a capital even if whoever wrote it did not use one.
  expect(cuerpo).toContain("The button");
  expect(cuerpo).toContain("feat/x · 2 files");
  expect(cuerpo).toContain("“look at your Button”");
  expect(cuerpo).toContain("separate window");
  // No form labels and no lead-ins.
  expect(cuerpo).not.toContain("Subject:");
  expect(cuerpo).not.toContain("Branch:");
  expect(dialogText(t)).not.toContain("Poochie");
});

test("with no context no empty line is painted, and a long body is cut at sentences", () => {
  const base = { id: "d2", subject: "s", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {} };
  const bare: any = { ...base, context: {}, messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "short" }] };
  expect(dialogParts(bare).cuerpo.split("\n")[1]).toBe("");
  const long = "A sentence that takes up some room and ends here. ".repeat(12);
  const withLong: any = { ...base, context: {}, messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: long }] };
  const c = dialogParts(withLong).cuerpo;
  expect(c).toContain("…");
  // Cut after a period, not mid-word.
  expect(c).toMatch(/\.\s…”/);
});

test("the normal notice is the native window, and the AppleScript box is the fallback", () => {
  // The real painter is `window.ts`. `display dialog` only comes out if the window
  // program does not start, because an ugly notice beats a spoochie nobody sees.
  const t: any = { id: "d3", subject: "s", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {}, context: {},
    messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "x" }] };
  const v = windowScript(t);
  expect(v).toStartWith("ObjC.import('Cocoa');");
  expect(v).toContain("runModalForWindow");
  expect(v).toContain("NSVisualEffectView");
  const g = osascriptScript(t, 10);
  expect(g).toStartWith("display dialog");
  expect(g).toContain("with icon POSIX file");
  expect(g).toContain(`default button "Let it in"`);
  expect(g).toContain(`cancel button "Not now"`);
  expect(g).toContain(`"Open in Slack"`);
  expect(g).toContain("giving up after 10");
});

test("the subject starts with a capital even if whoever wrote it did not use one", () => {
  const t: any = { id: "d4", subject: "saving blows up", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {}, context: {},
    messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "x" }] };
  expect(dialogParts(t).cuerpo).toStartWith("Saving blows up");
});

test("the notice goes to a dialog: the session gets nothing; accepting opens the aside, declining closes", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sp-dlg-bin-"));
  writeFileSync(join(bin, "dialog"), `#!/bin/sh
printf '%s\\n---\\n' "$1" >> "$SPOOCHIE_HOME/notices.txt"
# Decided by the question, not the subject: the subject gets painted with a capital.
case "$1" in *"question from no1"*) echo "Not now" ;; *) echo "Let it in" ;; esac
`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh
while IFS= read -r line; do printf '%s\\n' "$line" >> "$SPOOCHIE_HOME/aside-received.txt"; done
`);
  chmodSync(join(bin, "dialog"), 0o755); chmodSync(join(bin, "claude"), 0o755);
  mkdirSync(join(HOME, "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: true, human: "Edu", slack: { userId: "U_ME" } }), { mode: 0o600 });
  writeFileSync(join(HOME, "sessions", "S.json"),
    JSON.stringify({ sessionId: "S", name: "work", cwd: REPO, socket: S.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  daemon = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPOOCHIE_HOME: HOME, SPOOCHIE_WINDOW: "background", SPOOCHIE_NOTICE: join(bin, "dialog") }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  expect((await rpc({ op: "ping" })).pid).toBe(daemon.pid!);

  // A spoochie arrived from another machine, with no local side yet.
  const envelope = (id: string, subject: string) => ({
    id, subject, state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_ANA", name: "Ana", cwd: "(other machine)", human: "Ana", slackUser: "U_ANA" },
    to: { sessionId: "slack:U_ME", name: "me", cwd: "(this machine)", slackUser: "U_ME" },
    context: {}, messages: [{ at: Date.now(), from: "slack:U_ANA", author: "claude", kind: "text", text: `question from ${id}` }],
  });
  writeFileSync(join(HOME, "threads", "ok1.json"), JSON.stringify(envelope("ok1", "the button")));
  await rpc({ op: "claim", sessionId: "S" });

  // The dialog showed with the question; the aside was born in the session's repo and got the first turn.
  expect(await hasta(() => read(NOTICES).includes("question from ok1"))).toBe(true);
  expect(await hasta(() => read(RECEIVED).includes("the button") && read(RECEIVED).includes("question from ok1"))).toBe(true);
  expect(thread("ok1").state).toBe("open");
  expect(thread("ok1").to.cwd).toBe(REPO);

  // Declining closes, with no aside.
  writeFileSync(join(HOME, "threads", "no1.json"), JSON.stringify(envelope("no1", "decline me")));
  await rpc({ op: "claim", sessionId: "S" });
  expect(await hasta(() => thread("no1").state === "closed")).toBe(true);
  expect(thread("no1").closeReason).toContain("rejected");
  await sleep(300);
  expect(read(RECEIVED)).not.toContain("no1");

  // And the work session got NOTHING during the whole thing.
  expect(S.got).toEqual([]);
}, plazo(30_000));

/**
 * One on screen, period.
 *
 * Every pending spoochie popped its window as soon as it arrived. Measured with
 * twenty-five envelopes in a row from one contact: twenty-five windows at once, all
 * floating in the center and all stealing focus. And the worst part is not that the
 * machine becomes unusable: the quick way to clear a stack of modal windows is to hammer
 * Return, and this window's Return is "Let it in". The flood turns the accept button into
 * the emergency exit, and all it takes is the account of someone already in your
 * contacts.
 *
 * Here the "dialog" is a program that records that it showed up and then waits, which is
 * what the real one does while nobody presses.
 */
test("with several spoochies at once only one notice opens; the rest wait their turn", async () => {
  const bin2 = mkdtempSync(join(tmpdir(), "sp-queue-bin-"));
  const HOME2 = mkdtempSync(join(tmpdir(), "sp-queue-"));
  const REPO2 = mkdtempSync(join(tmpdir(), "repo-queue-"));
  writeFileSync(join(bin2, "dialog"), "#!/bin/sh\necho notice >> \"$SPOOCHIE_HOME/notices.txt\"\nsleep 120\n");
  chmodSync(join(bin2, "dialog"), 0o755);
  mkdirSync(join(HOME2, "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME2, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME2, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: false, human: "Edu", slack: { userId: "U_ME" } }), { mode: 0o600 });
  const box = fakeInbox("queue");
  writeFileSync(join(HOME2, "sessions", "S.json"),
    JSON.stringify({ sessionId: "S", name: "work", cwd: REPO2, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });

  const envelope = (id: string) => ({
    id, subject: "subject " + id, state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_ANA", name: "Ana", cwd: "(other machine)", human: "Ana", slackUser: "U_ANA" },
    to: { sessionId: "slack:U_ME", name: "me", cwd: "(this machine)", slackUser: "U_ME" },
    context: {}, messages: [{ at: Date.now(), from: "slack:U_ANA", author: "claude", kind: "text", text: "question " + id }],
  });
  for (let i = 0; i < 6; i++) writeFileSync(join(HOME2, "threads", "c" + i + ".json"), JSON.stringify(envelope("c" + i)));

  const d2 = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: bin2 + ":" + process.env.PATH, SPOOCHIE_HOME: HOME2, SPOOCHIE_WINDOW: "background", SPOOCHIE_NOTICE: join(bin2, "dialog") }, stdio: "ignore",
  });
  try {
    for (let i = 0; i < 60 && !existsSync(join(HOME2, "daemon.sock")); i++) await sleep(100);
    await new Promise<void>((res, rej) => {
      const c = net.createConnection({ path: join(HOME2, "daemon.sock") });
      c.on("error", rej);
      c.on("connect", () => c.write(JSON.stringify({ op: "claim", sessionId: "S" }) + "\n"));
      c.on("data", () => { c.destroy(); res(); });
    });
    const count = () => read(join(HOME2, "notices.txt")).trim().split("\n").filter(Boolean).length;
    expect(await hasta(() => count() >= 1)).toBe(true);
    // And it stays one: the other five wait for this one to be answered.
    await sleep(1500);
    expect(count()).toBe(1);
  } finally {
    d2.kill("SIGKILL");
    box.server.close();
  }
}, plazo(30_000));
