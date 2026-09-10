import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herramientasPermitidas, primerTurno } from "../src/aparte.ts";
import { hasta } from "./espera.ts";

/**
 * El Claude aparte de verdad es `claude -p`. Aqui hay uno falso en el PATH que apunta
 * cada turno que le entra por stdin. Con eso se prueba el reparto: el aparte recibe la
 * conversacion, la sesion interactiva solo el aviso. El registro lo hace el demonio.
 */
const HOME = mkdtempSync(join(tmpdir(), "spoochie-ap-"));
const DAEMON_SOCK = join(HOME, "daemon.sock");
const RECIBIDO = join(HOME, "aparte-recibido.txt");
// Directorios de verdad: el aparte se lanza con cwd ahi, y un cwd que no existe es ENOENT.
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
const recibido = () => existsSync(RECIBIDO) ? readFileSync(RECIBIDO, "utf8") : "";

const A = fakeInbox("apa"), B = fakeInbox("apb");
let daemon: ChildProcess;
afterAll(() => { daemon?.kill(); A.server.close(); B.server.close(); });

test("el aparte solo puede leer, hablar por el tunel y cerrar", () => {
  const h = herramientasPermitidas("/x/spoochie", false);
  expect(h.join(" ")).not.toContain("rtk");
  const conRtk = herramientasPermitidas("/x/spoochie", true);
  expect(conRtk).toContain("Bash(rtk git diff:*)");
  expect(conRtk).toContain("Bash(rtk /x/spoochie say:*)");
  expect(h).toContain("Read");
  expect(h).toContain("Bash(/x/spoochie say:*)");
  expect(h).toContain("Bash(git diff:*)");
  expect(h).not.toContain("Bash(git branch:*)");
  expect(h).toContain("Bash(git branch --list:*)");
  expect(h.join(" ")).not.toMatch(/Edit|Write|accept|release|discard|Bash\(sh|Bash\(git push/);
});

test("al aceptar, la conversacion va al Claude aparte y la sesion solo recibe el aviso", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sp-claude-ap-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh
# El registro lo hace el demonio al lanzarlo. Aqui solo se apunta lo que entra por stdin.
while IFS= read -r line; do printf '%s\\n' "$line" >> "$SPOOCHIE_HOME/aparte-recibido.txt"; done
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPOOCHIE_HOME: HOME, SPOOCHIE_VENTANA: "fondo" }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  expect((await rpc({ op: "ping" })).pid).toBe(daemon.pid!);

  const open = await rpc({ op: "open", sessionId: "PA", to: "repo-pb", subject: "el boton", body: "mira tu Button" });
  expect(open.ok).toBe(true);
  // La invitacion si entra en la sesion: es el humano quien acepta.
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${open.id}`)))).toBe(true);

  const antes = B.got.length;
  const acc = await rpc({ op: "accept", sessionId: "PB", id: open.id, by: "Edu" });
  expect(acc.ok).toBe(true);
  expect(acc.aparte).toBe(REPO_B);
  expect(acc.ventana).toBe(false);
  // El aparte nace en el directorio de la sesion que acepto y recibe el primer turno con el asunto.
  expect(await hasta(() => recibido().includes("Asunto: el boton") && recibido().includes("mira tu Button"))).toBe(true);
  // Aceptar otra vez, o tomarlo desde el mismo repo, no relanza nada: un solo primer turno.
  expect((await rpc({ op: "accept", sessionId: "PB", id: open.id, by: "Edu" })).already).toBe(true);
  const take = await rpc({ op: "take", sessionId: "PB", id: open.id });
  expect(take.ok).toBe(true);
  expect(take.already).toBe(true);
  await sleep(500);
  expect(recibido().split("Asunto: el boton").length - 1).toBe(1);

  // Lo que dice A ahora va al aparte, no a la sesion B. Y a B no le ha llegado NADA
  // desde la invitacion: ni "abierto", ni "lo atiende", ni la conversacion.
  const say = await rpc({ op: "say", sessionId: "PA", id: open.id, text: "es el min-width del contenedor, seguro" });
  expect(say.delivered).toBe(true);
  expect(await hasta(() => recibido().includes("min-width del contenedor"))).toBe(true);
  await sleep(300);
  expect(B.got.slice(antes)).toEqual([]);

  // Un aparte nunca es candidato para otro spoochie.
  const s = await rpc({ op: "sessions" });
  expect(s.sessions.find((x: any) => x.aparte === open.id)).toBeTruthy();
  const otro = await rpc({ op: "open", sessionId: "PA", to: "repo-pb", subject: "otro", body: "otra cosa" });
  expect(otro.ok).toBe(true);
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${otro.id}`)))).toBe(true);

  // Cerrar avisa al aparte por el mismo camino.
  await rpc({ op: "close", sessionId: "PA", id: open.id, reason: "resuelto" });
  expect(await hasta(() => recibido().includes("cerrado (resuelto)"))).toBe(true);
}, 30_000);

test("el primer turno lleva quien es, como contestar y lo dicho hasta ahora", () => {
  const t: any = { id: "z9", subject: "el boton", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "ap-z9", name: "aparte", cwd: "/b", human: "Edu" }, context: {}, state: "open",
    messages: [{ at: 1, from: "A", author: "claude", kind: "text", text: "mira tu Button" }, { at: 2, from: "A", author: "claude", kind: "text", text: "esto no", retenido: "si" }] };
  const p = primerTurno(t, "ap-z9", "/x/spoochie");
  expect(p).toContain("/x/spoochie say z9");
  expect(p).toContain("mira tu Button");
  expect(p).not.toContain("esto no");
  expect(p).toContain("Ana");
});

test("el entorno de un hijo no lleva el buzon de la sesion que lo arranco", async () => {
  const { entornoLimpio } = await import("../src/paths.ts");
  const base = {
    // Lo que hay de verdad en una sesion de Claude Code que arranca la CLI.
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/123.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "secreto",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    AWS_SECRET_ACCESS_KEY: "no",
    GITHUB_TOKEN: "tampoco",
    PATH: "/usr/bin", HOME: "/Users/x", TERM: "xterm-256color",
    SPOOCHIE_HOME: "/tmp/sp", ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_CONFIG_DIR: "/Users/x/.claude",
  };
  const env = entornoLimpio({ SPOOCHIE_APARTE: "v1" }, base as any);
  // La llave del buzon donde trabaja la persona no viaja al proceso que atiende a otra.
  expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
  expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  // Ni credenciales de otras cosas que esten sueltas en la terminal.
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  // Lo que si hace falta para que el hijo arranque y encuentre lo suyo.
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/Users/x");
  expect(env.SPOOCHIE_HOME).toBe("/tmp/sp");
  expect(env.SPOOCHIE_APARTE).toBe("v1");
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/x/.claude");
});
