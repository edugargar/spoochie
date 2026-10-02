import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogText, dialogParts, osascriptScript, windowScript } from "../src/dialog.ts";
import { hasta, plazo } from "./wait.ts";

/**
 * El aviso fuera de la terminal. Aqui el "dialogo" es un programa que recibe el texto y
 * contesta con un boton: Aceptar salvo que el asunto diga "rechazame". Con eso se prueba
 * lo que pidio Edu: la sesion donde trabaja no recibe NADA, ni la invitacion; aceptar
 * abre el aparte en su repo y la conversacion va alli; rechazar cierra el tunel.
 */
const HOME = mkdtempSync(join(tmpdir(), "spoochie-dlg-"));
const DAEMON_SOCK = join(HOME, "daemon.sock");
const RECIBIDO = join(HOME, "aparte-recibido.txt");
const AVISOS = join(HOME, "avisos.txt");
const REPO = mkdtempSync(join(tmpdir(), "repo-dlg-"));

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
const leer = (f: string) => existsSync(f) ? readFileSync(f, "utf8") : "";
const hilo = (id: string) => JSON.parse(readFileSync(join(HOME, "threads", `${id}.json`), "utf8"));

const S = fakeInbox("dlg");
let daemon: ChildProcess;
afterAll(() => { daemon?.kill(); S.server.close(); });

test("el aviso dice quien, que quiere, con que contexto y que pasa si abres, sin etiquetas", () => {
  const t: any = { id: "d1", subject: "el boton", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {}, context: { branch: "feat/x", files: ["a.ts", "b.ts"] },
    messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "mira tu Button" }] };
  const { titular, cuerpo } = dialogParts(t);
  // Lo primero que se lee es quien llama, no una entradilla.
  expect(titular).toBe("Ana llama.");
  // El asunto entra con mayuscula inicial aunque quien lo escribio no la pusiera.
  expect(cuerpo).toContain("El boton");
  expect(cuerpo).toContain("feat/x · 2 ficheros");
  expect(cuerpo).toContain("“mira tu Button”");
  expect(cuerpo).toContain("ventana aparte");
  // Ni etiquetas de formulario ni entradillas.
  expect(cuerpo).not.toContain("Asunto:");
  expect(cuerpo).not.toContain("Rama:");
  expect(dialogText(t)).not.toContain("Poochie");
});

test("sin contexto no se pinta una linea vacia, y un cuerpo largo se corta por frases", () => {
  const base = { id: "d2", subject: "s", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {} };
  const sin: any = { ...base, context: {}, messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "corto" }] };
  expect(dialogParts(sin).cuerpo.split("\n")[1]).toBe("");
  const largo = "Una frase que ocupa lo suyo y termina aqui. " .repeat(12);
  const con: any = { ...base, context: {}, messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: largo }] };
  const c = dialogParts(con).cuerpo;
  expect(c).toContain("…");
  // Cortado tras un punto, no a mitad de palabra.
  expect(c).toMatch(/\.\s…”/);
});

test("el aviso normal es la ventana nativa, y la caja de AppleScript es el plan B", () => {
  // El pintor de verdad es `ventana.ts`. `display dialog` solo sale si el programa de la
  // ventana no arranca, porque un aviso feo es mejor que un spoochie que nadie ve.
  const t: any = { id: "d3", subject: "s", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {}, context: {},
    messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "x" }] };
  const v = windowScript(t);
  expect(v).toStartWith("ObjC.import('Cocoa');");
  expect(v).toContain("runModalForWindow");
  expect(v).toContain("NSVisualEffectView");
  const g = osascriptScript(t, 10);
  expect(g).toStartWith("display dialog");
  expect(g).toContain("with icon POSIX file");
  expect(g).toContain(`default button "Que pase"`);
  expect(g).toContain(`cancel button "Ahora no"`);
  expect(g).toContain(`"Ver en Slack"`);
  expect(g).toContain("giving up after 10");
});

test("el asunto entra en mayuscula aunque quien lo escribio no la pusiera", () => {
  const t: any = { id: "d4", subject: "el guardado revienta", from: { sessionId: "slack:U1", name: "Ana", human: "Ana", cwd: "x" }, to: {}, context: {},
    messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "x" }] };
  expect(dialogParts(t).cuerpo).toStartWith("El guardado revienta");
});

test("el aviso va a un dialogo: la sesion no recibe nada; aceptar abre el aparte, rechazar cierra", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sp-dlg-bin-"));
  writeFileSync(join(bin, "dialogo"), `#!/bin/sh
printf '%s\\n---\\n' "$1" >> "$SPOOCHIE_HOME/avisos.txt"
# Se decide por la pregunta, no por el asunto: el asunto se pinta con mayuscula inicial.
case "$1" in *"pregunta de no1"*) echo Rechazar ;; *) echo Aceptar ;; esac
`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh
while IFS= read -r line; do printf '%s\\n' "$line" >> "$SPOOCHIE_HOME/aparte-recibido.txt"; done
`);
  chmodSync(join(bin, "dialogo"), 0o755); chmodSync(join(bin, "claude"), 0o755);
  mkdirSync(join(HOME, "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: true, human: "Edu", slack: { userId: "U_ME" } }), { mode: 0o600 });
  writeFileSync(join(HOME, "sessions", "S.json"),
    JSON.stringify({ sessionId: "S", name: "trabajo", cwd: REPO, socket: S.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  daemon = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPOOCHIE_HOME: HOME, SPOOCHIE_WINDOW: "background", SPOOCHIE_NOTICE: join(bin, "dialogo") }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  expect((await rpc({ op: "ping" })).pid).toBe(daemon.pid!);

  // Un spoochie llegado de otra maquina, sin lado local todavia.
  const sobre = (id: string, subject: string) => ({
    id, subject, state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_ANA", name: "Ana", cwd: "(otra maquina)", human: "Ana", slackUser: "U_ANA" },
    to: { sessionId: "slack:U_ME", name: "yo", cwd: "(esta maquina)", slackUser: "U_ME" },
    context: {}, messages: [{ at: Date.now(), from: "slack:U_ANA", author: "claude", kind: "text", text: `pregunta de ${id}` }],
  });
  writeFileSync(join(HOME, "threads", "ok1.json"), JSON.stringify(sobre("ok1", "el boton")));
  await rpc({ op: "claim", sessionId: "S" });

  // El dialogo se mostro con la pregunta; el aparte nacio en el repo de la sesion y recibio el primer turno.
  expect(await hasta(() => leer(AVISOS).includes("pregunta de ok1"))).toBe(true);
  expect(await hasta(() => leer(RECIBIDO).includes("el boton") && leer(RECIBIDO).includes("pregunta de ok1"))).toBe(true);
  expect(hilo("ok1").state).toBe("open");
  expect(hilo("ok1").to.cwd).toBe(REPO);

  // Rechazar cierra, sin aparte.
  writeFileSync(join(HOME, "threads", "no1.json"), JSON.stringify(sobre("no1", "rechazame")));
  await rpc({ op: "claim", sessionId: "S" });
  expect(await hasta(() => hilo("no1").state === "closed")).toBe(true);
  expect(hilo("no1").closeReason).toContain("rechazado");
  await sleep(300);
  expect(leer(RECIBIDO)).not.toContain("no1");

  // Y la sesion de trabajo no ha recibido NADA en todo el proceso.
  expect(S.got).toEqual([]);
}, plazo(30_000));

/**
 * Uno en pantalla, y punto.
 *
 * Cada spoochie pendiente sacaba su ventana en cuanto llegaba. Medido con veinticinco
 * sobres seguidos de un mismo contacto: veinticinco ventanas a la vez, todas flotando en
 * el centro y todas robando el foco. Y lo peor no es que la maquina quede inservible: la
 * forma rapida de quitar una pila de ventanas modales es machacar Return, y el Return de
 * esta ventana es "Que pase". La avalancha convierte el boton de aceptar en la salida de
 * emergencia, y hace falta la cuenta de alguien que ya esta en tu agenda.
 *
 * Aqui el "dialogo" es un programa que apunta que ha salido y se queda esperando, que es
 * lo que hace el de verdad mientras nadie pulsa.
 */
test("con varios spoochies a la vez solo se abre un aviso; el resto espera turno", async () => {
  const bin2 = mkdtempSync(join(tmpdir(), "sp-cola-bin-"));
  const HOME2 = mkdtempSync(join(tmpdir(), "sp-cola-"));
  const REPO2 = mkdtempSync(join(tmpdir(), "repo-cola-"));
  writeFileSync(join(bin2, "dialogo"), "#!/bin/sh\necho aviso >> \"$SPOOCHIE_HOME/avisos.txt\"\nsleep 120\n");
  chmodSync(join(bin2, "dialogo"), 0o755);
  mkdirSync(join(HOME2, "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(join(HOME2, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME2, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: false, human: "Edu", slack: { userId: "U_ME" } }), { mode: 0o600 });
  const caja = fakeInbox("cola");
  writeFileSync(join(HOME2, "sessions", "S.json"),
    JSON.stringify({ sessionId: "S", name: "trabajo", cwd: REPO2, socket: caja.sock, token: "t", pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });

  const sobre = (id: string) => ({
    id, subject: "asunto " + id, state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_ANA", name: "Ana", cwd: "(otra maquina)", human: "Ana", slackUser: "U_ANA" },
    to: { sessionId: "slack:U_ME", name: "yo", cwd: "(esta maquina)", slackUser: "U_ME" },
    context: {}, messages: [{ at: Date.now(), from: "slack:U_ANA", author: "claude", kind: "text", text: "pregunta " + id }],
  });
  for (let i = 0; i < 6; i++) writeFileSync(join(HOME2, "threads", "c" + i + ".json"), JSON.stringify(sobre("c" + i)));

  const d2 = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: bin2 + ":" + process.env.PATH, SPOOCHIE_HOME: HOME2, SPOOCHIE_WINDOW: "background", SPOOCHIE_NOTICE: join(bin2, "dialogo") }, stdio: "ignore",
  });
  try {
    for (let i = 0; i < 60 && !existsSync(join(HOME2, "daemon.sock")); i++) await sleep(100);
    await new Promise<void>((res, rej) => {
      const c = net.createConnection({ path: join(HOME2, "daemon.sock") });
      c.on("error", rej);
      c.on("connect", () => c.write(JSON.stringify({ op: "claim", sessionId: "S" }) + "\n"));
      c.on("data", () => { c.destroy(); res(); });
    });
    const cuenta = () => leer(join(HOME2, "avisos.txt")).trim().split("\n").filter(Boolean).length;
    expect(await hasta(() => cuenta() >= 1)).toBe(true);
    // Y sigue siendo uno: los otros cinco esperan a que este se conteste.
    await sleep(1500);
    expect(cuenta()).toBe(1);
  } finally {
    d2.kill("SIGKILL");
    caja.server.close();
  }
}, plazo(30_000));
