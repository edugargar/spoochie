import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * A daemon that restarts with a live spoochie.
 *
 * The real case: the laptop gets closed, the plugin updates, or launchd restarts
 * the daemon. The spoochie stays open on disk and the other side keeps talking. If on
 * coming back it doesn't pick up the thread, what was said meanwhile is silently lost: the sender
 * sees "delivered" and nothing comes in here.
 *
 * With its own BASE and its own relay directory: sharing them with another test made
 * the result depend on the order.
 */
const BASE = mkdtempSync(join(tmpdir(), "sp-re-"));
const HOME_C = join(BASE, "c"), HOME_D = join(BASE, "d"), NOSTR = join(BASE, "relays");
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
/** Like `rpc`, but if it fails it says which step it was: a bare ENOENT says nothing. */
async function step<T>(name: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { throw new Error(`[${name}] ${String(e)}`); }
}
const thread = (home: string, id: string) => { const p = join(home, "threads", `${id}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };

const C = fakeInbox("rec"), D = fakeInbox("red");
const daemons: ChildProcess[] = [];
afterAll(() => { for (const d of daemons) d.kill("SIGKILL"); C.server.close(); D.server.close(); });

test("a daemon that restarts with a live spoochie picks it up and the conversation goes on", async () => {
  // The real case: the laptop gets closed, the plugin updates, or launchd
  // restarts the daemon. The spoochie stays open on disk and the other side keeps
  // talking. If on coming back it doesn't pick up the thread, the messages from that while are lost
  // silently: whoever sent them sees "delivered" and nothing comes in here.
  const { myKeys } = await import("../src/nostr.ts");
  const kc = myKeys({} as any), kd = myKeys({} as any);

  const output: string[] = [];
  const start = (home: string) => {
    const d = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
      env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_WINDOW: "background" }, stdio: ["ignore", "pipe", "pipe"],
    });
    d.stdout?.on("data", x => output.push(`[${home.slice(-1)}] ${x}`));
    d.stderr?.on("data", x => output.push(`[${home.slice(-1)}] ${x}`));
    daemons.push(d);
    return d;
  };

  for (const [home, box, k, other, me, otherName, id] of [[HOME_C, C, kc, kd, "Cris", "Dani", "U_C"], [HOME_D, D, kd, kc, "Dani", "Cris", "U_D"]] as const) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: me,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otherName.toLowerCase()]: { id: otherName === "Cris" ? "U_C" : "U_D", name: otherName, npub: other.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${me.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    start(home);
  }
  const up = await hasta(() => existsSync(join(HOME_C, "daemon.sock")) && existsSync(join(HOME_D, "daemon.sock")), 15000);
  if (!up) throw new Error(`the daemons didn't start:\n${output.join("")}`);

  const open = await step("open", () => rpc(HOME_C, { op: "open", sessionId: "U_C", to: "@dani", subject: "the select", body: "it doesn't open in firefox" }));
  expect(open.ok).toBe(true);
  expect(await hasta(() => D.got.some(x => x.includes(`spoochie accept ${open.id}`)))).toBe(true);
  expect((await step("accept", () => rpc(HOME_D, { op: "accept", sessionId: "U_D", id: open.id, by: "Dani", aqui: true }))).ok).toBe(true);
  expect(await hasta(() => C.got.some(x => x.includes("accepted the tunnel")))).toBe(true);

  // Cris's daemon dies with the spoochie open.
  const cris = daemons[daemons.length - 2];
  cris.kill("SIGKILL");
  await hasta(() => !existsSync(join(HOME_C, "daemon.sock")) || cris.killed, 5000);
  expect(thread(HOME_C, open.id).state).toBe("open");

  // Dani keeps talking while the other side is away. The envelope stays in the "relays".
  await step("say from Dani", () => rpc(HOME_D, { op: "say", sessionId: "U_D", id: open.id, text: "it's the overlay's z-index" }));
  await sleep(500);

  // Cris comes back.
  const before = C.got.length;
  start(HOME_C);
  // Wait for it to ANSWER, not for the file to exist: the socket left by the one that
  // died abruptly is still there, and the new one deletes it before listening. Waiting for the file
  // is waiting for the dead one's.
  let pong: any = null;
  await hasta(async () => { try { pong = await rpc(HOME_C, { op: "ping" }); return true; } catch { return false; } }, 20000);
  if (!pong) {
    const log = join(HOME_C, "daemon.log");
    throw new Error(`the daemon didn't come back:\n${output.join("")}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-1500) : ""}`);
  }
  expect(pong.nostr).toBe(true);

  // What was said while it was away comes in now, and the conversation goes on both ways.
  expect(await hasta(() => C.got.slice(before).some(x => x.includes("overlay's z-index")), 20000)).toBe(true);
  const say = await step("say from Cris", () => rpc(HOME_C, { op: "say", sessionId: "U_C", id: open.id, text: "confirmed, that was it" }));
  expect(["publicado", "encolado", true]).toContain(say.delivered);
  expect(await hasta(() => D.got.some(x => x.includes("confirmed, that was it")), 15000)).toBe(true);

  await step("close", () => rpc(HOME_C, { op: "close", sessionId: "U_C", id: open.id, reason: "resolved" }));
}, plazo(90_000));
