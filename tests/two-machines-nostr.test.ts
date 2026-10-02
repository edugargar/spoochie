import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * Two real daemons, two states, zero Slack and zero relays: the "pool" is a shared
 * directory. Ana opens a spoochie with @bea, Bea's daemon receives it, Bea accepts,
 * answers, Ana closes, and on both sides only the envelope remains.
 */
const BASE = mkdtempSync(join(tmpdir(), "sp-2m-"));
const HOME_A = join(BASE, "a"), HOME_B = join(BASE, "b"), NOSTR = join(BASE, "reles");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fakeInbox(name: string) {
  const sock = join(mkdtempSync(join(tmpdir(), `sp-${name}-`)), "s.sock");
  const got: string[] = [];
  const server = net.createServer(c => {
    let buf = "";
    c.on("data", d => { buf += d.toString(); let i: number; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const f = JSON.parse(line); if (f.type === "user") got.push(f.message.content); } catch {} } });
  });
  server.listen(sock);
  return { sock, got, server };
}
function rpc(home: string, req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection({ path: join(home, "daemon.sock") });
    let buf = "";
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => { buf += d.toString(); const i = buf.indexOf("\n"); if (i >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
  });
}
const thread = (home: string, id: string) => { const p = join(home, "threads", `${id}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };

const A = fakeInbox("2ma"), B = fakeInbox("2mb");
const daemons: ChildProcess[] = [];
afterAll(() => { for (const d of daemons) d.kill(); A.server.close(); B.server.close(); });

test("two machines over Nostr: open, accept, answer, close, and only the envelope remains", async () => {
  const { myKeys } = await import("../src/nostr.ts");
  const ka = myKeys({} as any), kb = myKeys({} as any);
  for (const [home, box, k, other, me, otherName, id] of [[HOME_A, A, ka, kb, "Ana", "Bea", "U_A"], [HOME_B, B, kb, ka, "Bea", "Ana", "U_B"]] as const) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: me,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otherName.toLowerCase()]: { id: otherName === "Ana" ? "U_A" : "U_B", name: otherName, npub: other.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${me.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    const d = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], { env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_WINDOW: "background" }, stdio: "ignore" });
    daemons.push(d);
  }
  for (let i = 0; i < 60 && !(existsSync(join(HOME_A, "daemon.sock")) && existsSync(join(HOME_B, "daemon.sock"))); i++) await sleep(100);
  expect((await rpc(HOME_A, { op: "ping" })).nostr).toBe(true);
  expect((await rpc(HOME_B, { op: "ping" })).nostr).toBe(true);

  // Ana opens with @bea. No Slack on either machine.
  const open = await rpc(HOME_A, { op: "open", sessionId: "U_A", to: "@bea", subject: "the button", body: "look at your Button" });
  expect(open.ok).toBe(true);
  expect(thread(HOME_A, open.id).transporte).toBe("nostr");

  // Bea gets the whole invite in her session (terminal mode in the test).
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${open.id}`) && x.includes("look at your Button")))).toBe(true);
  expect(thread(HOME_B, open.id).from.human).toBe("Ana");

  // Bea accepts: Ana finds out. The accept notice still carries the Spanish marker
  // (threads.ts renderAccepted), which the bridges look for.
  expect((await rpc(HOME_B, { op: "accept", sessionId: "U_B", id: open.id, by: "Bea", aqui: true })).ok).toBe(true);
  expect(await hasta(() => A.got.some(x => x.includes("ha aceptado el tunel")))).toBe(true);

  // Bea answers: it reaches Ana as a turn.
  const say = await rpc(HOME_B, { op: "say", sessionId: "U_B", id: open.id, text: "it's the container's min-width" });
  expect(["publicado", "encolado", true]).toContain(say.delivered);
  expect(await hasta(() => A.got.some(x => x.includes("container's min-width")))).toBe(true);

  // Bea attaches a 45 KB screenshot: it goes in three envelopes and Ana has it in her spool, byte for byte.
  const screenshot = join(HOME_B, "pantalla.png");
  const bytes = Buffer.alloc(45 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  writeFileSync(screenshot, bytes);
  const withFile = await rpc(HOME_B, { op: "say", sessionId: "U_B", id: open.id, text: "this is how it looks", files: [screenshot] });
  expect(["publicado", "encolado", true]).toContain(withFile.delivered);
  expect(await hasta(() => A.got.some(x => x.includes("I'm leaving you a file")))).toBe(true);
  const pathOnA = A.got.find(x => x.includes("I'm leaving you a file"))!.match(new RegExp(`${HOME_A}\\S*pantalla\\.png`))?.[0];
  expect(pathOnA).toBeDefined();
  expect(readFileSync(pathOnA!).equals(bytes)).toBe(true);
  const { readdirSync: ls } = await import("node:fs");
  expect(ls(NOSTR).length).toBeGreaterThanOrEqual(6);

  // Ana closes: Bea finds out, and on both machines only the envelope remains.
  await rpc(HOME_A, { op: "close", sessionId: "U_A", id: open.id, reason: "resolved" });
  expect(await hasta(() => thread(HOME_B, open.id)?.state === "closed")).toBe(true);
  expect(await hasta(() => thread(HOME_B, open.id)?.borrado > 0)).toBe(true);
  expect(thread(HOME_A, open.id).messages).toEqual([]);
  expect(thread(HOME_B, open.id).messages).toEqual([]);
  expect(thread(HOME_B, open.id).closeReason).toBe("resolved");
  expect(JSON.stringify(thread(HOME_B, open.id))).not.toContain("min-width");
  // And the "relays" directory does not have the plaintext anywhere.
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(NOSTR)) { const s = readFileSync(join(NOSTR, f), "utf8"); expect(s).not.toContain("min-width"); expect(s).not.toContain("pantalla"); }
  // The screenshot left with the spoochie: Ana's spool no longer has it.
  expect(existsSync(join(HOME_A, "files", open.id))).toBe(false);

  // The whole promise, measured on disk rather than asserted: after closing, NO file on
  // either machine contains the conversation's text. Before, only the thread's JSON was
  // checked, which is where we already knew it was not.
  const { readdirSync: ls2, statSync } = await import("node:fs");
  const all = (dir: string): string[] => ls2(dir).flatMap(f => {
    const p = join(dir, f);
    try { return statSync(p).isDirectory() ? all(p) : [p]; } catch { return []; }
  });
  for (const home of [HOME_A, HOME_B]) {
    for (const f of all(home)) {
      if (f.endsWith("daemon.log")) continue; // the log carries ids and states, never text
      // The daemon socket is not a file that can be read (EOPNOTSUPP).
      let content: string;
      try { content = readFileSync(f).toString("utf8"); } catch { continue; }
      expect({ file: f, has: content.includes("container's min-width") }).toEqual({ file: f, has: false });
      expect({ file: f, has: content.includes("look at your Button") }).toEqual({ file: f, has: false });
    }
  }
}, plazo(40_000));
