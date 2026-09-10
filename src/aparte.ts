/**
 * El Claude aparte.
 *
 * Un spoochie que entra en la sesion donde estas trabajando te emborrona la pantalla
 * con una conversacion que no es la tuya. Asi que la sesion interactiva solo recibe
 * la invitacion, y la conversacion la atiende un Claude propio en una VENTANA NUEVA
 * de la terminal, abierta por el demonio en el repo que toque, con permisos de solo
 * lectura y la CLI de spoochie. Lo ves trabajar ahi y puedes escribirle. Vive lo que
 * vive el spoochie.
 *
 * Si no hay forma de abrir una ventana (Linux sin escritorio, tests, o la ventana no
 * se registra a tiempo) el aparte corre en segundo plano como `claude -p`, con su log
 * en ~/.claude/spoochie/aparte/<id>.log. Mismo Claude, misma correa, sin pantalla.
 *
 * Solo lectura de verdad: no hay Edit ni Write ni un Bash suelto. Lo unico que puede
 * correr es git de lectura y los subcomandos de spoochie que no abren ni sueltan nada.
 * En la ventana, cualquier otra cosa le pide permiso al humano que la mira.
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, openSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, ensureDirs } from "./paths.ts";
import * as T from "./threads.ts";
import { register, type SessionRecord } from "./registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APARTE_DIR = join(ROOT, "aparte");

/** Como invoca spoochie el Claude aparte: el mismo ejecutable que lleva este demonio. */
export function comandoCli(): string {
  if (import.meta.path.includes("$bunfs")) return process.execPath;
  return `${process.execPath} run ${join(HERE, "cli.ts")}`;
}

/** Lo unico que el Claude aparte puede ejecutar sin preguntar.
 *  Si la maquina tiene rtk (un proxy que reescribe cada comando a `rtk <cmd>` con un
 *  hook), los mismos comandos con `rtk` delante tambien: si no, cada git preguntaba. */
export function herramientasPermitidas(cli = comandoCli(), conRtk = Boolean(Bun.which("rtk"))): string[] {
  // `git branch` a secas admite -D y -f; solo se permite listar. El patron de
  // allowedTools casa por prefijo y no mira los argumentos, asi que esta lista por si
  // sola dejaba pasar `git diff --output=<fichero>`, que escribe. Quien mira los
  // argumentos es el portero (portero.ts), enganchado como hook PreToolUse en
  // `ajustesAparte`. Esta lista decide QUE programa; el portero decide COMO.
  const git = ["diff", "log", "show", "status", "branch --list", "blame", "grep", "ls-files"].map(g => `git ${g}`);
  const sp = ["say", "patch", "branch", "show", "list", "close", "transcript"].map(c => `${cli} ${c}`);
  const cmds = [...git, ...sp];
  const bash = [...cmds, ...(conRtk ? cmds.map(c => `rtk ${c}`) : [])].map(c => `Bash(${c}:*)`);
  // Artifact: el aparte publica el transcript de los spoochies que llegan, que el demonio
  // no puede publicar y la sesion interactiva no debe ver.
  return ["Read", "Grep", "Glob", "Artifact", ...bash];
}

/** Lo que el Claude aparte no puede hacer ni aunque el modo de permisos lo dejara:
 *  las reglas de denegacion mandan sobre cualquier modo. */
export const HERRAMIENTAS_PROHIBIDAS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git checkout:*)", "Bash(git reset:*)", "Bash(rm:*)"];

/** Los ajustes con los que arranca el Claude aparte.
 *
 *  `crossSessionInbound: accept` es lo que hace que el tunel le entregue los turnos.
 *  El hook `PreToolUse` es el portero: la lista blanca de arriba casa por prefijo y no
 *  mira los argumentos, asi que `git diff --output=fichero` la pasaba. El portero ve la
 *  linea entera antes de ejecutarla. Los dos modos (ventana y fondo) usan estos mismos
 *  ajustes: un aparte que se comporta distinto segun donde corre no es un control. */
export function ajustesAparte(cli = comandoCli()): Record<string, unknown> {
  return {
    crossSessionInbound: "accept",
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `${cli} portero` }] },
      ],
    },
  };
}

/** Con que modo de permisos arranca la ventana. "auto" por defecto: lo que no esta en la
 *  lista blanca lo decide el clasificador de Claude Code en vez de parar a preguntar; la
 *  primera prueba real dejo la ventana esperando un "ls" mientras la persona estaba en
 *  una reunion. SPOOCHIE_APARTE_PERMISOS=default vuelve a preguntar por todo. */
export function modoPermisos(): string {
  const v = process.env.SPOOCHIE_APARTE_PERMISOS;
  return v === "default" || v === "auto" ? v : "auto";
}

/** El primer turno: quien es, que spoochie atiende, lo dicho hasta ahora, y como contestar. */
export function primerTurno(t: T.Thread, sessionId: string, cli = comandoCli(), cwd = process.cwd(), origen?: string): string {
  const otro = T.otherSide(t, sessionId);
  const donde = origen
    ? `desde ${cwd}, que es una COPIA LIMPIA de ${origen} en su HEAD (git worktree). Lo que alli no este commiteado (cambios locales, .env) aqui no esta: si te preguntan por eso, dilo.`
    : `desde ${cwd}.`;
  const historia = t.messages.filter(m => m.retenido !== "si" && m.retenido !== "descartado")
    .map(m => T.renderMessage(t, m, sessionId)).join("\n\n");
  return [
    `Eres el Claude que atiende el spoochie ${t.id} en nombre de ${T.mySide(t, sessionId).human ?? "tu humano"}, ${donde}`,
    `Un spoochie es un tunel con la sesion de Claude de ${otro.human ?? otro.name}, otra persona. El tunel YA esta abierto: tu humano lo acepto.`,
    `Tu trabajo: leer este repo y contestar lo que pregunten sobre el, con hechos de los ficheros. Nada mas.`,
    `Contestas con:  ${cli} say ${t.id} "<texto>"   (o --file <ruta> si es largo). Un parche: ${cli} patch ${t.id} --from-git. Cerrar cuando este resuelto: ${cli} close ${t.id} --reason "...".`,
    `No puedes escribir ficheros ni correr nada que no sea git de lectura y spoochie: si te piden otra cosa, dilo por el tunel y para.`,
    `Cada mensaje nuevo del otro lado te llegara como un turno mas. Contesta a cada uno por el tunel, no aqui. Si tu humano te escribe en esta ventana, eso si es para ti.`,
    ``,
    `Asunto: ${t.subject}`,
    ``,
    historia,
  ].join("\n");
}

export type Modo = "ventana" | "fondo";
export type Aparte = {
  id: string; cwd: string; modo: Modo; sess: SessionRecord;
  /** Si `cwd` es una copia de trabajo, el checkout del que sale. */
  origen?: string;
  /** Solo en modo fondo: el `claude -p` cuyo stdin es nuestro. */
  child?: ChildProcess;
  /** Modo ventana: lo que llego antes de que la ventana se registrara. */
  cola: string[];
  /** Modo ventana: el hook de su sesion ya escribio el registro con socket. */
  listo: boolean;
  /** Modo fondo: el proceso ha muerto. */
  muerto: boolean;
};

/** El id de sesion de un aparte. Uno por lanzamiento: si el spoochie se mueve de repo
 *  con `take`, la ventana vieja y la nueva no comparten registro, y cerrar la vieja
 *  no cierra el spoochie. La CLI que corre dentro lo sabe por SPOOCHIE_APARTE_SESION. */
export const sesionAparte = (id: string) => `aparte-${id}-${Date.now().toString(36)}`;
export const nombreAparte = (id: string) => `aparte-${id}`;
/** El socket del registro provisional que escribe el demonio en modo ventana, hasta
 *  que el hook SessionStart de la ventana lo sustituya por el de verdad. */
export const SOCKET_PENDIENTE = "(esperando a la ventana)";

/**
 * Como se abre el aparte.
 *   SPOOCHIE_VENTANA=fondo      siempre en segundo plano (tests, servidores)
 *   SPOOCHIE_VENTANA=<programa> ese programa recibe el script y lo corre donde quiera (tests)
 *   sin nada                   ventana en macOS, fondo en el resto
 */
export function modo(): Modo {
  const v = process.env.SPOOCHIE_VENTANA;
  if (v === "fondo") return "fondo";
  if (v && v !== "ventana") return "ventana";
  return process.platform === "darwin" ? "ventana" : "fondo";
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** El script que corre la ventana nueva: entra en el repo y arranca claude con la correa.
 *  Rutas absolutas y PATH del demonio, porque una ventana abierta por AppleScript no
 *  pasa por el perfil de la shell y `claude` no estaria en su PATH. */
export function scriptVentana(t: T.Thread, cwd: string, sessionId: string): string {
  const claude = Bun.which("claude") ?? "claude";
  // Un demonio que corre desde un checkout de desarrollo (no desde el plugin instalado
  // ni compilado) le presta su propio plugin a la ventana, para que el hook que la
  // registra sea de la misma version que el demonio que la espera.
  const dev = !import.meta.path.includes("$bunfs") && !HERE.includes("/plugins/cache/") ? join(HERE, "..") : null;
  return [
    `#!/bin/sh`,
    `# spoochie ${t.id}: ${t.subject.replace(/\n/g, " ")}`,
    `export PATH=${sq(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}`,
    `export SPOOCHIE_APARTE=${sq(t.id)}`,
    `export SPOOCHIE_APARTE_SESION=${sq(sessionId)}`,
    process.env.SPOOCHIE_HOME ? `export SPOOCHIE_HOME=${sq(process.env.SPOOCHIE_HOME)}` : `unset SPOOCHIE_HOME`,
    `cd ${sq(cwd)} || exit 1`,
    `printf '\\033]0;spoochie ${t.id}\\007'`,
    `echo ${sq(`spoochie ${t.id} · ${t.subject}`)}`,
    `echo ${sq(`Claude aparte: solo lectura + spoochie say. Puedes escribirle aqui. Cerrar la ventana cierra el spoochie.`)}`,
    `exec ${sq(claude)} --name ${sq(`spoochie-${t.id}`)} --permission-mode ${modoPermisos()} --allowedTools ${sq(herramientasPermitidas().join(","))} --disallowedTools ${sq(HERRAMIENTAS_PROHIBIDAS.join(","))} --settings ${sq(JSON.stringify(ajustesAparte()))}${dev ? ` --plugin-dir ${sq(dev)}` : ""}`,
    ``,
  ].join("\n");
}

/** Abre una ventana de terminal que corre el script. Devuelve como lo hizo, o null.
 *  En macOS es Terminal.app con `open`, que no pide permisos. iTerm por AppleScript
 *  se probo: desde el demonio de launchd falla por el permiso de Automatizacion, y
 *  desde una shell se queda colgado esperando el dialogo. Un `.command` en Terminal
 *  abrio la ventana en 4 s sin preguntar nada. */
export function abrirVentana(script: string): string | null {
  const custom = process.env.SPOOCHIE_VENTANA;
  if (custom && custom !== "ventana") {
    const p = spawn(custom, [script], { detached: true, stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
    return custom;
  }
  if (process.platform !== "darwin") return null;
  const r = spawnSync("open", ["-a", "Terminal", script], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 ? "Terminal" : null;
}

/**
 * Lanza el Claude aparte para un spoochie en un directorio.
 *
 * En modo ventana el demonio escribe un registro provisional (para que el spoochie
 * apunte ya al aparte y nada mas caiga en la sesion interactiva) y abre la ventana;
 * el hook SessionStart de esa ventana sobreescribe el registro con su socket, y
 * entonces se le entrega lo acumulado. En modo fondo el registro lo hace el demonio
 * y la entrega va por stdin, sin socket.
 */
export function lanzar(t: T.Thread, cwd: string, como: Modo = modo()): Aparte | null {
  ensureDirs();
  mkdirSync(APARTE_DIR, { recursive: true, mode: 0o700 });
  const base = { sessionId: sesionAparte(t.id), name: nombreAparte(t.id), cwd, startedAt: Date.now(), aparte: t.id };
  const env = { ...process.env, SPOOCHIE_APARTE: t.id, SPOOCHIE_APARTE_SESION: base.sessionId };

  if (como === "ventana") {
    const script = join(APARTE_DIR, `${t.id}.command`);
    writeFileSync(script, scriptVentana(t, cwd, base.sessionId), { mode: 0o700 });
    chmodSync(script, 0o700);
    const sess: SessionRecord = { ...base, socket: SOCKET_PENDIENTE, token: "", pid: process.pid };
    register(sess);
    const con = abrirVentana(script);
    if (!con) return null;
    return { id: t.id, cwd, modo: "ventana", sess, cola: [], listo: false, muerto: false };
  }

  const out = openSync(join(APARTE_DIR, `${t.id}.log`), "a");
  const child = spawn("claude", [
    "-p", "--verbose",
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--settings", JSON.stringify(ajustesAparte()),
    "--name", `spoochie-${t.id}`,
    "--permission-mode", "default",
    "--allowedTools", herramientasPermitidas().join(","),
    "--disallowedTools", HERRAMIENTAS_PROHIBIDAS.join(","),
  ], { cwd, env, stdio: ["pipe", out, out] });
  child.on("error", () => {});
  const sess: SessionRecord = { ...base, socket: "(stdin)", token: "", pid: child.pid ?? 0 };
  register(sess);
  const a: Aparte = { id: t.id, cwd, modo: "fondo", sess, child, cola: [], listo: true, muerto: false };
  child.on("exit", () => { a.muerto = true; });
  return a;
}

/** Un turno por la entrada estandar del aparte en modo fondo. */
export function turnoStdin(a: Aparte, content: string): boolean {
  const c = a.child;
  if (!c || !c.stdin || c.stdin.destroyed || c.exitCode !== null) return false;
  return c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

/** El registro de verdad que deja el hook de la ventana, si ya esta. */
export function registroVentana(a: Aparte, vivas: SessionRecord[]): SessionRecord | undefined {
  return vivas.find(s => s.aparte === a.id && s.socket !== SOCKET_PENDIENTE && s.socket !== "(stdin)");
}

export function vivo(a: Aparte): boolean {
  return a.modo === "fondo" ? !a.muerto : true;
}

export function matar(a: Aparte) {
  if (a.child) { try { a.child.kill(); } catch {} }
}

/**
 * Una copia limpia del repo para que el aparte trabaje en ella: `git worktree add
 * --detach` de HEAD en ~/.claude/spoochie/aparte/<id>-copia. Comparte objetos con el
 * checkout (no duplica el .git), tarda lo que tarda un checkout, y lo que no esta
 * commiteado no viaja. Si el directorio no es un repo git, null: se atiende en el sitio.
 */
export function copiaDeTrabajo(cwd: string, id: string): string | null {
  try { execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { stdio: "ignore" }); } catch { return null; }
  mkdirSync(APARTE_DIR, { recursive: true, mode: 0o700 });
  const destino = join(APARTE_DIR, `${id}-copia`);
  try {
    rmSync(destino, { recursive: true, force: true });
    execFileSync("git", ["-C", cwd, "worktree", "prune"], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "worktree", "add", "--detach", destino, "HEAD"], { stdio: "ignore" });
    return destino;
  } catch { return null; }
}

export function quitarCopia(origen: string, copia: string) {
  try { execFileSync("git", ["-C", origen, "worktree", "remove", "--force", copia], { stdio: "ignore" }); }
  catch { rmSync(copia, { recursive: true, force: true }); }
}
