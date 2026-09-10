import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta } from "./espera.ts";

/**
 * Un demonio que se reinicia con un spoochie vivo.
 *
 * El caso de verdad: se cierra el portatil, se actualiza el plugin, o launchd reinicia
 * el demonio. El spoochie sigue abierto en disco y el otro lado sigue hablando. Si al
 * volver no recoge el hilo, lo dicho en ese rato se pierde en silencio: quien lo mando
 * ve "entregado" y aqui no entra nada.
 *
 * Con su propio BASE y su propio directorio de reles: compartirlos con otro test hacia
 * que el resultado dependiera del orden.
 */
const BASE = mkdtempSync(join(tmpdir(), "sp-re-"));
const HOME_C = join(BASE, "c"), HOME_D = join(BASE, "d"), NOSTR = join(BASE, "reles");
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
/** Como `rpc`, pero si falla dice en que paso fue: un ENOENT suelto no dice nada. */
async function paso<T>(nombre: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { throw new Error(`[${nombre}] ${String(e)}`); }
}
const hilo = (home: string, id: string) => { const p = join(home, "threads", `${id}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };

const C = fakeInbox("rec"), D = fakeInbox("red");
const demonios: ChildProcess[] = [];
afterAll(() => { for (const d of demonios) d.kill("SIGKILL"); C.server.close(); D.server.close(); });

test("un demonio que se reinicia con un spoochie vivo lo recoge y la conversacion sigue", async () => {
  // El caso de verdad: se cierra el portatil, se actualiza el plugin, o launchd
  // reinicia el demonio. El spoochie sigue abierto en disco y el otro lado sigue
  // hablando. Si al volver no recoge el hilo, los mensajes de ese rato se pierden en
  // silencio: el que los mando ve "entregado" y aqui no entra nada.
  const { misClaves } = await import("../src/nostr.ts");
  const kc = misClaves({} as any), kd = misClaves({} as any);

  const salida: string[] = [];
  const arrancar = (home: string) => {
    const d = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
      env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_AVISO: "terminal", SPOOCHIE_VENTANA: "fondo" }, stdio: ["ignore", "pipe", "pipe"],
    });
    d.stdout?.on("data", x => salida.push(`[${home.slice(-1)}] ${x}`));
    d.stderr?.on("data", x => salida.push(`[${home.slice(-1)}] ${x}`));
    demonios.push(d);
    return d;
  };

  for (const [home, box, k, otro, yo, otroNombre, id] of [[HOME_C, C, kc, kd, "Cris", "Dani", "U_C"], [HOME_D, D, kd, kc, "Dani", "Cris", "U_D"]] as const) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: yo,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otroNombre.toLowerCase()]: { id: otroNombre === "Cris" ? "U_C" : "U_D", name: otroNombre, npub: otro.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${yo.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    arrancar(home);
  }
  const arriba = await hasta(() => existsSync(join(HOME_C, "daemon.sock")) && existsSync(join(HOME_D, "daemon.sock")), 15000);
  if (!arriba) throw new Error(`los demonios no arrancaron:\n${salida.join("")}`);

  const open = await paso("open", () => rpc(HOME_C, { op: "open", sessionId: "U_C", to: "@dani", subject: "el select", body: "no se abre en firefox" }));
  expect(open.ok).toBe(true);
  expect(await hasta(() => D.got.some(x => x.includes(`spoochie accept ${open.id}`)))).toBe(true);
  expect((await paso("accept", () => rpc(HOME_D, { op: "accept", sessionId: "U_D", id: open.id, by: "Dani", aqui: true }))).ok).toBe(true);
  expect(await hasta(() => C.got.some(x => x.includes("ha aceptado el tunel")))).toBe(true);

  // Se muere el demonio de Cris con el spoochie abierto.
  const cris = demonios[demonios.length - 2];
  cris.kill("SIGKILL");
  await hasta(() => !existsSync(join(HOME_C, "daemon.sock")) || cris.killed, 5000);
  expect(hilo(HOME_C, open.id).state).toBe("open");

  // Dani sigue hablando mientras el otro lado no esta. El sobre queda en los "reles".
  await paso("say de Dani", () => rpc(HOME_D, { op: "say", sessionId: "U_D", id: open.id, text: "es el z-index del overlay" }));
  await sleep(500);

  // Cris vuelve.
  const antes = C.got.length;
  arrancar(HOME_C);
  // Se espera a que CONTESTE, no a que exista el fichero: el socket que dejo el que
  // murio de golpe sigue ahi, y el nuevo lo borra antes de escuchar. Esperar al fichero
  // es esperar al del muerto.
  let pong: any = null;
  await hasta(async () => { try { pong = await rpc(HOME_C, { op: "ping" }); return true; } catch { return false; } }, 20000);
  if (!pong) {
    const log = join(HOME_C, "daemon.log");
    throw new Error(`el demonio no volvio:\n${salida.join("")}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-1500) : ""}`);
  }
  expect(pong.nostr).toBe(true);

  // Lo dicho mientras no estaba entra ahora, y la conversacion sigue en los dos sentidos.
  expect(await hasta(() => C.got.slice(antes).some(x => x.includes("z-index del overlay")), 20000)).toBe(true);
  const say = await paso("say de Cris", () => rpc(HOME_C, { op: "say", sessionId: "U_C", id: open.id, text: "confirmado, era eso" }));
  expect(["publicado", "encolado", true]).toContain(say.delivered);
  expect(await hasta(() => D.got.some(x => x.includes("confirmado, era eso")), 15000)).toBe(true);

  await paso("close", () => rpc(HOME_C, { op: "close", sessionId: "U_C", id: open.id, reason: "resuelto" }));
}, 90_000);
