import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * An earlier version talking to HEAD, in both directions.
 *
 * spoochie ships as a binary pinned to a plugin version, so two mismatched machines is
 * the NORMAL case for the weeks between a release and people updating. Nothing tested
 * it: protocol changes were reviewed by eye.
 *
 * It only runs if SPOOCHIE_OLD points at a tree of the earlier version, because setting
 * it up costs a `git archive` and a `bun install`. In CI the `compatibilidad` job does
 * it; locally:
 *
 *   mkdir -p /tmp/sp-vieja && git archive v0.9.8 | tar -x -C /tmp/sp-vieja
 *   (cd /tmp/sp-vieja && bun install)
 *   SPOOCHIE_OLD=/tmp/sp-vieja bun test tests/compat.test.ts
 */
const OLD = process.env.SPOOCHIE_OLD;
const present = Boolean(OLD && existsSync(join(OLD!, "src", "daemon.ts")));

const BASE = mkdtempSync(join(tmpdir(), "sp-compat-"));
const NEW_HOME = join(BASE, "nueva"), OLD_HOME = join(BASE, "vieja"), NOSTR = join(BASE, "reles");
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

const N = fakeInbox("cn"), V = fakeInbox("cv");
const daemons: ChildProcess[] = [];
afterAll(() => { for (const d of daemons) d.kill("SIGKILL"); N.server.close(); V.server.close(); });

test.if(present)("the earlier version and HEAD understand each other in both directions", async () => {
  const version = execFileSync("bun", ["run", join(OLD!, "src", "cli.ts"), "--version"], { encoding: "utf8" }).trim();
  console.log(`compatibility: HEAD against ${version}`);

  const { myKeys } = await import("../src/nostr.ts");
  const kn = myKeys({} as any), kv = myKeys({} as any);
  const homes: [string, ReturnType<typeof fakeInbox>, typeof kn, typeof kv, string, string, string, string][] = [
    [NEW_HOME, N, kn, kv, "Nueva", "Vieja", "U_N", join(import.meta.dir, "..", "src", "daemon.ts")],
    [OLD_HOME, V, kv, kn, "Vieja", "Nueva", "U_V", join(OLD!, "src", "daemon.ts")],
  ];
  for (const [home, box, k, other, me, otherName, id, daemon] of homes) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: me,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otherName.toLowerCase()]: { id: otherName === "Nueva" ? "U_N" : "U_V", name: otherName, npub: other.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${me.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    daemons.push(spawn("bun", ["run", daemon], {
      env: {
        ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_WINDOW: "background",
        // The old version reads only the old Spanish names.
        SPOOCHIE_AVISO: "terminal", SPOOCHIE_VENTANA: "fondo",
      },
      stdio: "ignore",
    }));
  }
  expect(await hasta(async () => { try { await rpc(NEW_HOME, { op: "ping" }); await rpc(OLD_HOME, { op: "ping" }); return true; } catch { return false; } })).toBe(true);

  // HEAD -> old. HEAD's envelope carries fields the old one does not know (to, ts, sv):
  // they have to be ignored without breaking anything, not drop the message.
  const a = await rpc(NEW_HOME, { op: "open", sessionId: "U_N", to: "@vieja", subject: "backwards", body: "this comes from HEAD" });
  expect(a.ok).toBe(true);
  expect(await hasta(() => V.got.some(x => x.includes("this comes from HEAD")))).toBe(true);
  expect((await rpc(OLD_HOME, { op: "accept", sessionId: "U_V", id: a.id, by: "Vieja", aqui: true })).ok).toBe(true);
  await rpc(OLD_HOME, { op: "say", sessionId: "U_V", id: a.id, text: "and the old one answers this" });
  // And the old one's answer, signed with v1, gets into HEAD labelled as old.
  expect(await hasta(() => N.got.some(x => x.includes("and the old one answers this")))).toBe(true);

  // old -> HEAD.
  const b = await rpc(OLD_HOME, { op: "open", sessionId: "U_V", to: "@nueva", subject: "forwards", body: "this comes from the old one" });
  expect(b.ok).toBe(true);
  expect(await hasta(() => N.got.some(x => x.includes("this comes from the old one")))).toBe(true);
  expect((await rpc(NEW_HOME, { op: "accept", sessionId: "U_N", id: b.id, by: "Nueva", aqui: true })).ok).toBe(true);
  await rpc(NEW_HOME, { op: "say", sessionId: "U_N", id: b.id, text: "HEAD answers" });
  expect(await hasta(() => V.got.some(x => x.includes("HEAD answers")))).toBe(true);
}, plazo(90_000));

test.if(!present)("without SPOOCHIE_OLD, the version matrix does not run (and says so)", () => {
  // It must not skip silently: a test that does not exist and one that does not run look
  // too alike when someone glances at the suite summary.
  expect(present).toBe(false);
});
