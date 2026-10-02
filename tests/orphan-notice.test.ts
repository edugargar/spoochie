import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * The notice doesn't outlive its daemon.
 *
 * It's an osascript child of the daemon. In the 01-10 real test the daemon was killed and the
 * notice stayed on screen: clicking accept there no longer reached anyone. The same happens
 * on update, which restarts the daemon with a notice open.
 */
const BASE = mkdtempSync(join(tmpdir(), "sp-orphan-"));
const HOME_A = join(BASE, "a"), HOME_B = join(BASE, "b"), NOSTR = join(BASE, "relays");
const NOTICE_PID = join(BASE, "notice.pid");
// This test's "notice": it records its pid and waits, like a window nobody clicks.
const NOTICE = join(BASE, "notice.sh");
writeFileSync(NOTICE, `#!/bin/sh\necho $$ > ${NOTICE_PID}\nexec sleep 600\n`);
chmodSync(NOTICE, 0o700);

function inbox(name: string) {
  const sock = join(mkdtempSync(join(tmpdir(), `sp-${name}-`)), "s.sock");
  const server = net.createServer(() => {});
  server.listen(sock);
  return { sock, server };
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const A = inbox("ha"), B = inbox("hb");
const daemons: ChildProcess[] = [];
afterAll(() => {
  for (const d of daemons) d.kill();
  A.server.close(); B.server.close();
  try { process.kill(Number(readFileSync(NOTICE_PID, "utf8"))); } catch {}
});

test("when the daemon shuts down, its open notice closes", async () => {
  const { myKeys } = await import("../src/nostr.ts");
  const ka = myKeys({} as any), kb = myKeys({} as any);
  const rows = [[HOME_A, A, ka, kb, "Ana", "Bea", "U_A", "terminal"], [HOME_B, B, kb, ka, "Bea", "Ana", "U_B", NOTICE]] as const;
  for (const [home, box, k, other, me, otherName, id, notice] of rows) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: me,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otherName.toLowerCase()]: { id: otherName === "Ana" ? "U_A" : "U_B", name: otherName, npub: other.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${me.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    daemons.push(spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
      env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_NOTICE: notice, SPOOCHIE_WINDOW: "background" }, stdio: "ignore",
    }));
  }
  expect(await hasta(() => existsSync(join(HOME_A, "daemon.sock")) && existsSync(join(HOME_B, "daemon.sock")))).toBe(true);

  expect((await rpc(HOME_A, { op: "open", sessionId: "U_A", to: "@bea", subject: "the button", body: "look at your Button" })).ok).toBe(true);
  expect(await hasta(() => existsSync(NOTICE_PID))).toBe(true);
  const pid = Number(readFileSync(NOTICE_PID, "utf8"));
  expect(alive(pid)).toBe(true);

  daemons[1].kill("SIGTERM");
  expect(await hasta(() => !alive(pid), 3000)).toBe(true);
}, plazo(30_000));
