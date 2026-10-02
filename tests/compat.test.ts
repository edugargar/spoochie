import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * Una version anterior hablando con HEAD, en las dos direcciones.
 *
 * spoochie se distribuye como un binario fijado a una version de plugin, asi que dos
 * maquinas desparejadas es el caso NORMAL durante las semanas que van de una release a
 * que la gente actualice. Nada lo probaba: los cambios de protocolo se revisaban a ojo.
 *
 * Se corre solo si SPOOCHIE_OLD apunta a un arbol de la version anterior, porque
 * prepararlo cuesta un `git archive` y un `bun install`. En CI lo hace el job
 * `compatibilidad`; en local:
 *
 *   mkdir -p /tmp/sp-vieja && git archive v0.9.8 | tar -x -C /tmp/sp-vieja
 *   (cd /tmp/sp-vieja && bun install)
 *   SPOOCHIE_OLD=/tmp/sp-vieja bun test tests/compat.test.ts
 */
const VIEJA = process.env.SPOOCHIE_OLD;
const hay = Boolean(VIEJA && existsSync(join(VIEJA!, "src", "daemon.ts")));

const BASE = mkdtempSync(join(tmpdir(), "sp-compat-"));
const NUEVA_HOME = join(BASE, "nueva"), VIEJA_HOME = join(BASE, "vieja"), NOSTR = join(BASE, "reles");
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
const demonios: ChildProcess[] = [];
afterAll(() => { for (const d of demonios) d.kill("SIGKILL"); N.server.close(); V.server.close(); });

test.if(hay)("la version anterior y HEAD se entienden en las dos direcciones", async () => {
  const version = execFileSync("bun", ["run", join(VIEJA!, "src", "cli.ts"), "--version"], { encoding: "utf8" }).trim();
  console.log(`compatibilidad: HEAD contra ${version}`);

  const { myKeys } = await import("../src/nostr.ts");
  const kn = myKeys({} as any), kv = myKeys({} as any);
  const casas: [string, ReturnType<typeof fakeInbox>, typeof kn, typeof kv, string, string, string, string][] = [
    [NUEVA_HOME, N, kn, kv, "Nueva", "Vieja", "U_N", join(import.meta.dir, "..", "src", "daemon.ts")],
    [VIEJA_HOME, V, kv, kn, "Vieja", "Nueva", "U_V", join(VIEJA!, "src", "daemon.ts")],
  ];
  for (const [home, box, k, otro, yo, otroNombre, id, daemon] of casas) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      guardian: false, transcript: false, aparte: false, human: yo,
      nostr: { sk: k.sk, pk: k.pk, relays: ["wss://x"] },
      contacts: { [otroNombre.toLowerCase()]: { id: otroNombre === "Nueva" ? "U_N" : "U_V", name: otroNombre, npub: otro.pk, relays: ["wss://x"] } },
    }), { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, name: `repo-${yo.toLowerCase()}`, cwd: home, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    demonios.push(spawn("bun", ["run", daemon], {
      env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOSTR_DIR: NOSTR, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_WINDOW: "background" }, stdio: "ignore",
    }));
  }
  expect(await hasta(async () => { try { await rpc(NUEVA_HOME, { op: "ping" }); await rpc(VIEJA_HOME, { op: "ping" }); return true; } catch { return false; } })).toBe(true);

  // HEAD -> vieja. El sobre de HEAD lleva campos que la vieja no conoce (to, ts, sv):
  // tienen que ser ignorados sin romper nada, no descartar el mensaje.
  const a = await rpc(NUEVA_HOME, { op: "open", sessionId: "U_N", to: "@vieja", subject: "hacia atras", body: "esto sale de HEAD" });
  expect(a.ok).toBe(true);
  expect(await hasta(() => V.got.some(x => x.includes("esto sale de HEAD")))).toBe(true);
  expect((await rpc(VIEJA_HOME, { op: "accept", sessionId: "U_V", id: a.id, by: "Vieja", aqui: true })).ok).toBe(true);
  await rpc(VIEJA_HOME, { op: "say", sessionId: "U_V", id: a.id, text: "y esto contesta la vieja" });
  // Y la respuesta de la vieja, firmada con la v1, entra en HEAD marcada como vieja.
  expect(await hasta(() => N.got.some(x => x.includes("y esto contesta la vieja")))).toBe(true);

  // vieja -> HEAD.
  const b = await rpc(VIEJA_HOME, { op: "open", sessionId: "U_V", to: "@nueva", subject: "hacia delante", body: "esto sale de la vieja" });
  expect(b.ok).toBe(true);
  expect(await hasta(() => N.got.some(x => x.includes("esto sale de la vieja")))).toBe(true);
  expect((await rpc(NUEVA_HOME, { op: "accept", sessionId: "U_N", id: b.id, by: "Nueva", aqui: true })).ok).toBe(true);
  await rpc(NUEVA_HOME, { op: "say", sessionId: "U_N", id: b.id, text: "contesta HEAD" });
  expect(await hasta(() => V.got.some(x => x.includes("contesta HEAD")))).toBe(true);
}, plazo(90_000));

test.if(!hay)("sin SPOOCHIE_OLD, la matriz de versiones no corre (y se dice)", () => {
  // Que no corra en silencio: un test que no existe y uno que no se ejecuta se parecen
  // demasiado cuando alguien mira el resumen de la suite.
  expect(hay).toBe(false);
});
