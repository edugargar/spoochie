import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptVentana } from "../src/aparte.ts";

/**
 * El Claude aparte en una ventana nueva. Aqui no hay iTerm: SPOOCHIE_VENTANA apunta a un
 * "abridor" que corre el script en segundo plano, y el `claude` del PATH es uno falso
 * que hace lo que haria el hook SessionStart de la ventana (registrar su sesion con un
 * socket) y se queda vivo. Con eso se prueba lo que fallo en e856: que la conversacion
 * va a la ventana por su socket, que a la sesion interactiva no le llega nada mas, que
 * un segundo accept/take en el mismo repo no abre otra ventana, y que cerrar la ventana
 * cierra el spoochie.
 */
const HOME = mkdtempSync(join(tmpdir(), "spoochie-vent-"));
const DAEMON_SOCK = join(HOME, "daemon.sock");
const VENTANAS = join(HOME, "ventanas.txt");
const REPO_A = mkdtempSync(join(tmpdir(), "repo-va-")), REPO_B = mkdtempSync(join(tmpdir(), "repo-vb-"));

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
async function hasta(pred: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50; i++) { if (pred()) return true; await sleep(50); } return pred(); }
const ventanas = () => existsSync(VENTANAS) ? readFileSync(VENTANAS, "utf8").trim().split("\n").filter(Boolean) : [];

// A y B son sesiones interactivas; V es el buzon de la ventana del aparte.
const A = fakeInbox("va"), B = fakeInbox("vb"), V = fakeInbox("vv");
let daemon: ChildProcess;
afterAll(() => { daemon?.kill(); A.server.close(); B.server.close(); V.server.close(); });

test("el script de la ventana entra en el repo, lleva la correa y las variables del aparte", () => {
  const t: any = { id: "w1", subject: "el boton", messages: [] };
  const s = scriptVentana(t, "/tmp/mi repo", "aparte-w1-x");
  expect(s).toContain("cd '/tmp/mi repo'");
  expect(s).toContain("SPOOCHIE_APARTE='w1'");
  expect(s).toContain("SPOOCHIE_APARTE_SESION='aparte-w1-x'");
  expect(s).toContain("--allowedTools");
  // Desde que ventana y fondo comparten `banderasAparte`, cada palabra del exec va
  // entrecomillada por sq(), banderas incluidas: al shell le llega igual.
  expect(s).toContain("'--permission-mode' 'auto'");
  // Lo prohibido va en la lista de denegacion, no en la blanca.
  expect(s).toMatch(/'--disallowedTools' '[^']*Edit,Write[^']*git push/);
  expect(s.split("--allowedTools")[1].split("--disallowedTools")[0]).not.toMatch(/Edit|Write/);
});

test("la conversacion va a la ventana por su socket; la sesion no ve nada mas; no se abre dos veces; cerrarla cierra el spoochie", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sp-claude-vent-"));
  // El abridor: lo que hace iTerm de verdad. Corre el script y vuelve.
  writeFileSync(join(bin, "abridor"), `#!/bin/sh
nohup /bin/sh "$1" >/dev/null 2>&1 &
`);
  // El claude falso de la ventana: se registra como lo haria el hook y se queda vivo.
  writeFileSync(join(bin, "claude"), `#!/bin/sh
echo "$SPOOCHIE_APARTE_SESION $PWD" >> "$SPOOCHIE_HOME/ventanas.txt"
cat > "$SPOOCHIE_HOME/sessions/$SPOOCHIE_APARTE_SESION.json" <<JSON
{"sessionId":"$SPOOCHIE_APARTE_SESION","name":"aparte-$SPOOCHIE_APARTE","cwd":"$PWD","socket":"${V.sock}","token":"t","pid":$$,"startedAt":$(date +%s)000,"aparte":"$SPOOCHIE_APARTE"}
JSON
chmod 600 "$SPOOCHIE_HOME/sessions/$SPOOCHIE_APARTE_SESION.json"
sleep 60
`);
  chmodSync(join(bin, "claude"), 0o755); chmodSync(join(bin, "abridor"), 0o755);

  mkdirSync(join(HOME, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ guardian: false, transcript: true, aparte: true, human: "Edu" }), { mode: 0o600 });
  for (const [id, box, cwd] of [["VA", A, REPO_A], ["VB", B, REPO_B]] as const) {
    writeFileSync(join(HOME, "sessions", `${id}.json`),
      JSON.stringify({ sessionId: id, name: `repo-${id.toLowerCase()}`, cwd, socket: box.sock, token: "t", pid: process.pid, startedAt: Date.now() }),
      { mode: 0o600 });
  }
  daemon = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPOOCHIE_HOME: HOME, SPOOCHIE_VENTANA: join(bin, "abridor") }, stdio: "ignore",
  });
  for (let i = 0; i < 60 && !existsSync(DAEMON_SOCK); i++) await sleep(100);
  expect((await rpc({ op: "ping" })).pid).toBe(daemon.pid!);

  const open = await rpc({ op: "open", sessionId: "VA", to: "repo-vb", subject: "el boton", body: "mira tu Button" });
  expect(open.ok).toBe(true);
  expect(await hasta(() => B.got.some(x => x.includes(`spoochie accept ${open.id}`)))).toBe(true);
  const antesB = B.got.length;
  // Un spoochie que llega de otra maquina no tiene quien publique su transcript: se simula
  // quitandole el dueno que `open` le puso aqui. El aparte tiene que quedarselo.
  const ruta = join(HOME, "threads", `${open.id}.json`);
  const hilo = JSON.parse(readFileSync(ruta, "utf8")); delete hilo.transcriptOwner; writeFileSync(ruta, JSON.stringify(hilo));

  const acc = await rpc({ op: "accept", sessionId: "VB", id: open.id, by: "Edu" });
  expect(acc.ok).toBe(true);
  expect(acc.aparte).toBe(REPO_B);
  expect(acc.ventana).toBe(true);
  // Lo que A dice mientras la ventana arranca no cae en B: se guarda para la ventana.
  const say0 = await rpc({ op: "say", sessionId: "VA", id: open.id, text: "y el min-width, miralo" });
  expect(say0.ok).toBe(true);

  // La ventana se abrio en el repo de B, se registro, y recibio el primer turno y lo guardado, en orden.
  expect(await hasta(() => ventanas().length === 1, 10_000)).toBe(true);
  expect(ventanas()[0]).toContain(REPO_B);
  expect(await hasta(() => V.got.length >= 2, 10_000)).toBe(true);
  expect(V.got[0]).toContain("Asunto: el boton");
  expect(V.got[0]).toContain("mira tu Button");
  expect(V.got[0]).toContain(`desde ${REPO_B}`);
  // Y el encargo de publicar el transcript va con el, no con la sesion interactiva.
  expect(V.got[0]).toContain("republica el transcript");
  expect(V.got[0]).toContain(`spoochie transcript ${open.id} --url`);
  expect(B.got.join("\n")).not.toContain("republica el transcript");
  expect(V.got[1]).toContain("min-width");

  // Un turno mas va directo por el socket de la ventana.
  const say = await rpc({ op: "say", sessionId: "VA", id: open.id, text: "es el contenedor, seguro" });
  expect(say.delivered).toBe(true);
  expect(await hasta(() => V.got.some(x => x.includes("es el contenedor")))).toBe(true);

  // Otro accept y un take desde el mismo repo: ninguna ventana mas.
  expect((await rpc({ op: "accept", sessionId: "VB", id: open.id, by: "Edu" })).already).toBe(true);
  const take = await rpc({ op: "take", sessionId: "VB", id: open.id });
  expect(take.already).toBe(true);
  await sleep(800);
  expect(ventanas().length).toBe(1);

  // A la sesion B no le ha llegado nada desde la invitacion.
  expect(B.got.slice(antesB)).toEqual([]);

  // Cerrar la ventana (su hook SessionEnd) cierra el spoochie y avisa al otro lado.
  const sid = ventanas()[0].split(" ")[0];
  const fin = await rpc({ op: "session-end", sessionId: sid });
  expect(fin.closed).toEqual([open.id]);
  expect(await hasta(() => A.got.some(x => x.includes("se cerro la ventana del Claude aparte")))).toBe(true);
}, 40_000);
