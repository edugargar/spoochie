import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedTools, firstTurn } from "../src/aside.ts";
import { hasta, plazo } from "./wait.ts";

/**
 * The real aside Claude is `claude -p`. Here there is a fake one on the PATH that
 * records every turn coming in on stdin. That tests the split: the aside gets the
 * conversation, the interactive session only the notice. The daemon does the
 * registering.
 */
const HOME = mkdtempSync(join(tmpdir(), "spoochie-aside-"));
const DAEMON_SOCK = join(HOME, "daemon.sock");
const RECEIVED = join(HOME, "aside-received.txt");
// Real directories: the aside is launched with its cwd there, and a cwd that does not exist is ENOENT.
const REPO_A = mkdtempSync(join(tmpdir(), "repo-pa-")), REPO_B = mkdtempSync(join(tmpdir(), "repo-pb-"));

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
const received = () => existsSync(RECEIVED) ? readFileSync(RECEIVED, "utf8") : "";

const A = fakeInbox("apa"), B = fakeInbox("apb");
let daemon: ChildProcess;
afterAll(() => { daemon?.kill(); A.server.close(); B.server.close(); });

test("the aside can only read, talk through the tunnel and close", () => {
  const h = allowedTools("/x/spoochie", false);
  expect(h.join(" ")).not.toContain("rtk");
  const withRtk = allowedTools("/x/spoochie", true);
  expect(withRtk).toContain("Bash(rtk git diff:*)");
  expect(withRtk).toContain("Bash(rtk /x/spoochie say:*)");
  expect(h).toContain("Read");
  expect(h).toContain("Bash(/x/spoochie say:*)");
  expect(h).toContain("Bash(git diff:*)");
  expect(h).not.toContain("Bash(git branch:*)");
  expect(h).toContain("Bash(git branch --list:*)");
  expect(h.join(" ")).not.toMatch(/Edit|Write|accept|release|discard|Bash\(sh|Bash\(git push/);
});

test("on accept, the conversation goes to the aside Claude and the session only gets the notice", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sp-claude-ap-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh
# The daemon registers it when it launches it. Here we only record what comes in on stdin.
while IFS= read -r line; do printf '%s\\n' "$line" >> "$SPOOCHIE_HOME/aside-received.txt"; done
`);

  chmodSync(join(bin, "claude"), 0o755);

  mkdirSync(join(HOME, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: true, human: "Edu" }), { mode: 0o600 });
  for (const [id, box, cwd] of [["PA", A, REPO_A], ["PB", B, REPO_B]] as const) {
    writeFileSync(join(HOME, "sessions", `${id}.json`),
      JSON.stringify({ sessionId: id, name: `repo-${id.toLowerCase()}`, cwd, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }),
      { mode: 0o600 });
  }
  daemon = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPOOCHIE_HOME: HOME, SPOOCHIE_WINDOW: "background" }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  expect((await rpc({ op: "ping" })).pid).toBe(daemon.pid!);

  const open = await rpc({ op: "open", sessionId: "PA", to: "repo-pb", subject: "the button", body: "look at your Button" });
  expect(open.ok).toBe(true);
  // The invitation does go into the session: the human is the one who accepts.
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${open.id}`)))).toBe(true);

  const before = B.got.length;
  const acc = await rpc({ op: "accept", sessionId: "PB", id: open.id, by: "Edu" });
  expect(acc.ok).toBe(true);
  expect(acc.aparte).toBe(REPO_B);
  expect(acc.ventana).toBe(false);
  // The aside is born in the directory of the session that accepted and gets the first turn with the subject.
  expect(await hasta(() => received().includes("Subject: the button") && received().includes("look at your Button"))).toBe(true);
  // Accepting again, or taking it from the same repo, relaunches nothing: a single first turn.
  expect((await rpc({ op: "accept", sessionId: "PB", id: open.id, by: "Edu" })).already).toBe(true);
  const take = await rpc({ op: "take", sessionId: "PB", id: open.id });
  expect(take.ok).toBe(true);
  expect(take.already).toBe(true);
  await sleep(500);
  expect(received().split("Subject: the button").length - 1).toBe(1);

  // What A says now goes to the aside, not to session B. And B has received NOTHING
  // since the invitation: no "opened", no "handled by", no conversation.
  const say = await rpc({ op: "say", sessionId: "PA", id: open.id, text: "it is the container min-width, for sure" });
  expect(say.delivered).toBe(true);
  expect(await hasta(() => received().includes("container min-width"))).toBe(true);
  await sleep(300);
  expect(B.got.slice(before)).toEqual([]);

  // An aside is never a candidate for another spoochie.
  const s = await rpc({ op: "sessions" });
  expect(s.sessions.find((x: any) => x.aparte === open.id)).toBeTruthy();
  const another = await rpc({ op: "open", sessionId: "PA", to: "repo-pb", subject: "another", body: "something else" });
  expect(another.ok).toBe(true);
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${another.id}`)))).toBe(true);

  // Closing tells the aside the same way.
  await rpc({ op: "close", sessionId: "PA", id: open.id, reason: "resolved" });
  expect(await hasta(() => received().includes("cerrado (resolved)"))).toBe(true);
}, plazo(30_000));

test("the first turn carries who it is, how to answer and what was said so far", () => {
  const t: any = { id: "z9", subject: "the button", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "ap-z9", name: "aside", cwd: "/b", human: "Edu" }, context: {}, state: "open",
    messages: [{ at: 1, from: "A", author: "claude", kind: "text", text: "look at your Button" }, { at: 2, from: "A", author: "claude", kind: "text", text: "not this one", retenido: "si" }] };
  const p = firstTurn(t, "ap-z9", "/x/spoochie");
  expect(p).toContain("/x/spoochie say z9");
  expect(p).toContain("look at your Button");
  expect(p).not.toContain("not this one");
  expect(p).toContain("Ana");
});

test("a child's environment does not carry the inbox of the session that started it", async () => {
  const { cleanEnv } = await import("../src/paths.ts");
  const base = {
    // What a Claude Code session that starts the CLI really has.
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/123.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    AWS_SECRET_ACCESS_KEY: "no",
    GITHUB_TOKEN: "nor-this",
    PATH: "/usr/bin", HOME: "/Users/x", TERM: "xterm-256color",
    SPOOCHIE_HOME: "/tmp/sp", ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_CONFIG_DIR: "/Users/x/.claude",
  };
  const env = cleanEnv({ SPOOCHIE_ASIDE: "v1" }, base as any);
  // The key to the inbox where the person works does not travel to the process serving someone else.
  expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
  expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  // Nor credentials for other things lying around in the terminal.
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  // What the child does need to start and find its own things.
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/Users/x");
  expect(env.SPOOCHIE_HOME).toBe("/tmp/sp");
  expect(env.SPOOCHIE_ASIDE).toBe("v1");
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/x/.claude");
});
