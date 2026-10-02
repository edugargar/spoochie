import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * Dos demonios de verdad, dos estados, cero Slack y cero reles: el "pool" es un directorio
 * compartido. Ana abre un spoochie con @bea, el demonio de Bea lo recibe, Bea acepta,
 * contesta, Ana cierra, y en los dos lados queda solo el sobre.
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
const hilo = (home: string, id: string) => { const p = join(home, "threads", `${id}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };

const A = fakeInbox("2ma"), B = fakeInbox("2mb");
const demonios: ChildProcess[] = [];
afterAll(() => { for (const d of demonios) d.kill(); A.server.close(); B.server.close(); });

test("dos maquinas por Nostr: abrir, aceptar, contestar, cerrar, y solo queda el sobre", async () => {
  const { myKeys } = await import("../src/nostr.ts");
  const ka = myKeys({} as any), kb = myKeys({} as any);
  for (const [home, box, k, otro, yo, otroNombre, id] of [[HOME_A, A, ka, kb, "Ana", "Bea", "U_A"], [HOME_B, B, kb, ka, "Bea", "Ana", "U_B"]] as const) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: yo,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otroNombre.toLowerCase()]: { id: otroNombre === "Ana" ? "U_A" : "U_B", name: otroNombre, npub: otro.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${yo.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    const d = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], { env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_AVISO: "terminal", SPOOCHIE_VENTANA: "fondo" }, stdio: "ignore" });
    demonios.push(d);
  }
  for (let i = 0; i < 60 && !(existsSync(join(HOME_A, "daemon.sock")) && existsSync(join(HOME_B, "daemon.sock"))); i++) await sleep(100);
  expect((await rpc(HOME_A, { op: "ping" })).nostr).toBe(true);
  expect((await rpc(HOME_B, { op: "ping" })).nostr).toBe(true);

  // Ana abre con @bea. Sin Slack en ninguna de las dos maquinas.
  const open = await rpc(HOME_A, { op: "open", sessionId: "U_A", to: "@bea", subject: "el boton", body: "mira tu Button" });
  expect(open.ok).toBe(true);
  expect(hilo(HOME_A, open.id).transporte).toBe("nostr");

  // A Bea le llega la invitacion entera en su sesion (modo terminal en el test).
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${open.id}`) && x.includes("mira tu Button")))).toBe(true);
  expect(hilo(HOME_B, open.id).from.human).toBe("Ana");

  // Bea acepta: Ana se entera.
  expect((await rpc(HOME_B, { op: "accept", sessionId: "U_B", id: open.id, by: "Bea", aqui: true })).ok).toBe(true);
  expect(await hasta(() => A.got.some(x => x.includes("ha aceptado el tunel")))).toBe(true);

  // Bea contesta: le llega a Ana como turno.
  const say = await rpc(HOME_B, { op: "say", sessionId: "U_B", id: open.id, text: "es el min-width del contenedor" });
  expect(["publicado", "encolado", true]).toContain(say.delivered);
  expect(await hasta(() => A.got.some(x => x.includes("min-width del contenedor")))).toBe(true);

  // Bea adjunta una captura de 45 KB: va en tres sobres y Ana la tiene en su spool, byte a byte.
  const captura = join(HOME_B, "pantalla.png");
  const bytes = Buffer.alloc(45 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  writeFileSync(captura, bytes);
  const conFichero = await rpc(HOME_B, { op: "say", sessionId: "U_B", id: open.id, text: "asi se ve", files: [captura] });
  expect(["publicado", "encolado", true]).toContain(conFichero.delivered);
  expect(await hasta(() => A.got.some(x => x.includes("Te dejo un fichero")))).toBe(true);
  const rutaEnA = A.got.find(x => x.includes("Te dejo un fichero"))!.match(new RegExp(`${HOME_A}\\S*pantalla\\.png`))?.[0];
  expect(rutaEnA).toBeDefined();
  expect(readFileSync(rutaEnA!).equals(bytes)).toBe(true);
  const { readdirSync: ls } = await import("node:fs");
  expect(ls(NOSTR).length).toBeGreaterThanOrEqual(6);

  // Ana cierra: Bea se entera, y en las dos maquinas solo queda el sobre.
  await rpc(HOME_A, { op: "close", sessionId: "U_A", id: open.id, reason: "resuelto" });
  expect(await hasta(() => hilo(HOME_B, open.id)?.state === "closed")).toBe(true);
  expect(await hasta(() => hilo(HOME_B, open.id)?.borrado > 0)).toBe(true);
  expect(hilo(HOME_A, open.id).messages).toEqual([]);
  expect(hilo(HOME_B, open.id).messages).toEqual([]);
  expect(hilo(HOME_B, open.id).closeReason).toBe("resuelto");
  expect(JSON.stringify(hilo(HOME_B, open.id))).not.toContain("min-width");
  // Y el directorio de "reles" no tiene el texto en claro por ningun sitio.
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(NOSTR)) { const s = readFileSync(join(NOSTR, f), "utf8"); expect(s).not.toContain("min-width"); expect(s).not.toContain("pantalla"); }
  // La captura se fue con el spoochie: el spool de Ana ya no la tiene.
  expect(existsSync(join(HOME_A, "files", open.id))).toBe(false);

  // La promesa entera, medida en disco y no afirmada: despues de cerrar, NINGUN fichero
  // de ninguna de las dos maquinas contiene el texto de la conversacion. Antes se
  // comprobaba solo el JSON del hilo, que es donde ya sabiamos que no estaba.
  const { readdirSync: ls2, statSync } = await import("node:fs");
  const todos = (dir: string): string[] => ls2(dir).flatMap(f => {
    const p = join(dir, f);
    try { return statSync(p).isDirectory() ? todos(p) : [p]; } catch { return []; }
  });
  for (const home of [HOME_A, HOME_B]) {
    for (const f of todos(home)) {
      if (f.endsWith("daemon.log")) continue; // el log lleva ids y estados, nunca texto
      // El socket del demonio no es un fichero que se pueda leer (EOPNOTSUPP).
      let contenido: string;
      try { contenido = readFileSync(f).toString("utf8"); } catch { continue; }
      expect({ fichero: f, tiene: contenido.includes("min-width del contenedor") }).toEqual({ fichero: f, tiene: false });
      expect({ fichero: f, tiene: contenido.includes("mira tu Button") }).toEqual({ fichero: f, tiene: false });
    }
  }
}, plazo(40_000));
