import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./espera.ts";

/**
 * El aviso no sobrevive a su demonio.
 *
 * Es un osascript hijo del demonio. En la prueba real del 01-10 se mato al demonio y el
 * aviso siguio en pantalla: pulsar "Que pase" ahi ya no llegaba a nadie. Lo mismo pasa
 * al actualizar, que reinicia el demonio con un aviso abierto.
 */
const BASE = mkdtempSync(join(tmpdir(), "sp-huerfano-"));
const HOME_A = join(BASE, "a"), HOME_B = join(BASE, "b"), NOSTR = join(BASE, "reles");
const PID_AVISO = join(BASE, "aviso.pid");
// El "aviso" de este test: apunta su pid y espera, como una ventana que nadie pulsa.
const AVISO = join(BASE, "aviso.sh");
writeFileSync(AVISO, `#!/bin/sh\necho $$ > ${PID_AVISO}\nexec sleep 600\n`);
chmodSync(AVISO, 0o700);

function buzon(name: string) {
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
const vivo = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const A = buzon("ha"), B = buzon("hb");
const demonios: ChildProcess[] = [];
afterAll(() => {
  for (const d of demonios) d.kill();
  A.server.close(); B.server.close();
  try { process.kill(Number(readFileSync(PID_AVISO, "utf8"))); } catch {}
});

test("al apagarse el demonio, su aviso abierto se cierra", async () => {
  const { misClaves } = await import("../src/nostr.ts");
  const ka = misClaves({} as any), kb = misClaves({} as any);
  const filas = [[HOME_A, A, ka, kb, "Ana", "Bea", "U_A", "terminal"], [HOME_B, B, kb, ka, "Bea", "Ana", "U_B", AVISO]] as const;
  for (const [home, box, k, otro, yo, otroNombre, id, aviso] of filas) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: yo,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otroNombre.toLowerCase()]: { id: otroNombre === "Ana" ? "U_A" : "U_B", name: otroNombre, npub: otro.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${yo.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    demonios.push(spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
      env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_AVISO: aviso, SPOOCHIE_VENTANA: "fondo" }, stdio: "ignore",
    }));
  }
  expect(await hasta(() => existsSync(join(HOME_A, "daemon.sock")) && existsSync(join(HOME_B, "daemon.sock")))).toBe(true);

  expect((await rpc(HOME_A, { op: "open", sessionId: "U_A", to: "@bea", subject: "el boton", body: "mira tu Button" })).ok).toBe(true);
  expect(await hasta(() => existsSync(PID_AVISO))).toBe(true);
  const pid = Number(readFileSync(PID_AVISO, "utf8"));
  expect(vivo(pid)).toBe(true);

  demonios[1].kill("SIGTERM");
  expect(await hasta(() => !vivo(pid), 3000)).toBe(true);
}, plazo(30_000));
