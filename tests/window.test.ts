import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowScript } from "../src/aside.ts";
import { hasta, plazo } from "./wait.ts";

/**
 * The aside Claude in a new window. There is no iTerm here: SPOOCHIE_WINDOW points at an
 * "opener" that runs the script in the background, and the `claude` on the PATH is a
 * fake one that does what the window's SessionStart hook would do (register its session
 * with a socket) and stays alive. That tests what failed in e856: that the conversation
 * goes to the window through its socket, that nothing more reaches the interactive
 * session, that a second accept/take in the same repo opens no other window, and that
 * closing the window closes the spoochie.
 */
const HOME = mkdtempSync(join(tmpdir(), "spoochie-win-"));
const DAEMON_SOCK = join(HOME, "daemon.sock");
const WINDOWS = join(HOME, "windows.txt");
const REPO_A = mkdtempSync(join(tmpdir(), "repo-va-")), REPO_B = mkdtempSync(join(tmpdir(), "repo-vb-"));

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
const windows = () => existsSync(WINDOWS) ? readFileSync(WINDOWS, "utf8").trim().split("\n").filter(Boolean) : [];

// A and B are interactive sessions; V is the inbox of the aside's window.
const A = fakeInbox("va"), B = fakeInbox("vb"), V = fakeInbox("vv");
let daemon: ChildProcess;
afterAll(() => { daemon?.kill(); A.server.close(); B.server.close(); V.server.close(); });

test("the window script enters the repo, carries the leash and the aside's variables", () => {
  const t: any = { id: "w1", subject: "the button", messages: [] };
  const s = windowScript(t, "/tmp/my repo", "aparte-w1-x");
  expect(s).toContain("cd '/tmp/my repo'");
  expect(s).toContain("SPOOCHIE_ASIDE='w1'");
  expect(s).toContain("SPOOCHIE_ASIDE_SESSION='aparte-w1-x'");
  expect(s).toContain("--allowedTools");
  // Since window and background share `asideFlags`, every word of the exec is quoted
  // by sq(), flags included: the shell gets the same thing.
  expect(s).toContain("'--permission-mode' 'auto'");
  // What is forbidden goes in the deny list, not the allowlist.
  expect(s).toMatch(/'--disallowedTools' '[^']*Edit,Write[^']*git push/);
  expect(s.split("--allowedTools")[1].split("--disallowedTools")[0]).not.toMatch(/Edit|Write/);
});

test("the conversation goes to the window through its socket; the session sees nothing more; it does not open twice; closing it closes the spoochie", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sp-claude-win-"));
  // The opener: what iTerm really does. It runs the script and returns.
  writeFileSync(join(bin, "opener"), `#!/bin/sh
nohup /bin/sh "$1" >/dev/null 2>&1 &
`);
  // The window's fake claude: it registers the way the hook would and stays alive.
  // Like the hook: to a separate file and an mv, which replaces the provisional record
  // in one go. With "cat >" the daemon could read it empty halfway through the write,
  // take it as missing and lose the say arriving at that instant: on CI ubuntu, 3 of 8
  // runs (the say FAILED 3 ms after the accept). register() writes atomically.
  writeFileSync(join(bin, "claude"), `#!/bin/sh
echo "$SPOOCHIE_ASIDE_SESSION $PWD" >> "$SPOOCHIE_HOME/windows.txt"
f="$SPOOCHIE_HOME/sessions/$SPOOCHIE_ASIDE_SESSION.json"
cat > "$f.tmp" <<JSON
{"sessionId":"$SPOOCHIE_ASIDE_SESSION","name":"aparte-$SPOOCHIE_ASIDE","cwd":"$PWD","socket":"${V.sock}","token":"t","pid":$$,"startedAt":$(date +%s)000,"aparte":"$SPOOCHIE_ASIDE"}
JSON
chmod 600 "$f.tmp"
mv "$f.tmp" "$f"
sleep 60
`);
  chmodSync(join(bin, "claude"), 0o755); chmodSync(join(bin, "opener"), 0o755);

  mkdirSync(join(HOME, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ guardian: false, transcript: true, aparte: true, human: "Edu" }), { mode: 0o600 });
  for (const [id, box, cwd] of [["VA", A, REPO_A], ["VB", B, REPO_B]] as const) {
    writeFileSync(join(HOME, "sessions", `${id}.json`),
      JSON.stringify({ sessionId: id, name: `repo-${id.toLowerCase()}`, cwd, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }),
      { mode: 0o600 });
  }
  daemon = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPOOCHIE_HOME: HOME, SPOOCHIE_WINDOW: join(bin, "opener") }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  expect((await rpc({ op: "ping" })).pid).toBe(daemon.pid!);

  const open = await rpc({ op: "open", sessionId: "VA", to: "repo-vb", subject: "the button", body: "look at your Button" });
  expect(open.ok).toBe(true);
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${open.id}`)))).toBe(true);
  const beforeB = B.got.length;
  // A spoochie arriving from another machine has nobody to publish its transcript: this
  // is simulated by removing the owner `open` gave it here. The aside has to take it.
  const path = join(HOME, "threads", `${open.id}.json`);
  const thread = JSON.parse(readFileSync(path, "utf8")); delete thread.transcriptOwner; writeFileSync(path, JSON.stringify(thread));

  const acc = await rpc({ op: "accept", sessionId: "VB", id: open.id, by: "Edu" });
  expect(acc.ok).toBe(true);
  expect(acc.aparte).toBe(REPO_B);
  expect(acc.ventana).toBe(true);
  // What A says while the window starts does not land in B: it is kept for the window.
  const say0 = await rpc({ op: "say", sessionId: "VA", id: open.id, text: "and the min-width, check it" });
  expect(say0.ok).toBe(true);

  // The window opened in B's repo, registered, and got the first turn and what was kept, in order.
  expect(await hasta(() => windows().length === 1, 10_000)).toBe(true);
  expect(windows()[0]).toContain(REPO_B);
  const arrived = await hasta(() => V.got.length >= 2, 10_000);
  // On CI, only on Dependabot PRs, this failed twice in a row (01-10 and 02-10) and
  // never locally or in Docker with the same tree. Without the daemon log there is no
  // way to know why: it gets printed here instead of guessing.
  if (!arrived) {
    console.log(`V.got=${JSON.stringify(V.got)}\nB.got=${B.got.length}\n--- daemon.log\n${existsSync(join(HOME, "daemon.log")) ? readFileSync(join(HOME, "daemon.log"), "utf8") : "(none)"}`);
    const { readdirSync, statSync } = await import("node:fs");
    for (const f of readdirSync(join(HOME, "sessions"))) {
      const p = join(HOME, "sessions", f);
      console.log(`--- sessions/${f} mode ${(statSync(p).mode & 0o777).toString(8)}\n${readFileSync(p, "utf8")}`);
    }
  }
  expect(arrived).toBe(true);
  expect(V.got[0]).toContain("Subject: the button");
  expect(V.got[0]).toContain("look at your Button");
  expect(V.got[0]).toContain(`from ${REPO_B}`);
  // And the job of publishing the transcript goes with it, not with the interactive session.
  expect(V.got[0]).toContain("republish the transcript");
  expect(V.got[0]).toContain(`spoochie transcript ${open.id} --url`);
  expect(B.got.join("\n")).not.toContain("republish the transcript");
  expect(V.got[1]).toContain("min-width");

  // One more turn goes straight through the window's socket.
  const say = await rpc({ op: "say", sessionId: "VA", id: open.id, text: "it is the container, for sure" });
  expect(say.delivered).toBe(true);
  expect(await hasta(() => V.got.some(x => x.includes("it is the container")))).toBe(true);

  // Another accept and a take from the same repo: no more windows.
  expect((await rpc({ op: "accept", sessionId: "VB", id: open.id, by: "Edu" })).already).toBe(true);
  const take = await rpc({ op: "take", sessionId: "VB", id: open.id });
  expect(take.already).toBe(true);
  await sleep(800);
  expect(windows().length).toBe(1);

  // Session B has received nothing since the invitation.
  expect(B.got.slice(beforeB)).toEqual([]);

  // Closing the window (its SessionEnd hook) closes the spoochie and tells the other side.
  const sid = windows()[0].split(" ")[0];
  const end = await rpc({ op: "session-end", sessionId: sid });
  expect(end.closed).toEqual([open.id]);
  expect(await hasta(() => A.got.some(x => x.includes("the aside Claude's window was closed")))).toBe(true);
}, plazo(40_000));
