#!/usr/bin/env bun
/**
 * La prueba real: dos personas, dos Claude de verdad, una conversacion que tiene que llegar.
 *
 * El 01-10 se abrio un spoochie entre dos personas con la suite en verde y fallo todo: el clic de
 * "Que pase" llegaba vacio al demonio, y el demonio no encontraba `claude`. Los tests no lo
 * vieron porque usan buzones falsos, reles en un directorio, un claude falso en el PATH y
 * un clic dentro del guion. Aqui no hay nada de eso:
 *
 *   - dos SPOOCHIE_HOME vacios, Ana y Bea, cada uno con su demonio arrancado con el entorno
 *     exacto que le daria launchd (el PATH y el HOME del plist, nada mas);
 *   - Ana corre con Bun sobre el codigo; Bea con el binario compilado, como quien no
 *     tiene Bun, y su PATH de launchd no lleva el directorio de bun;
 *   - reles Nostr publicos de verdad;
 *   - el alta por `/spoochie:join` dentro de un Claude de verdad en una ventana de Terminal;
 *   - Ana pide en lenguaje normal a su Claude que le pregunte algo a Bea;
 *   - el aviso sale en pantalla y se pulsa "Que pase" con el raton (CGEvent);
 *   - el Claude aparte de Bea lee su repo y contesta;
 *   - la respuesta tiene que llegar al Claude de Ana como turno, y Ana la escribe en disco.
 *
 * La pregunta es un numero al azar que solo esta en el repo de Bea: si llega a Ana, la
 * conversacion entera ocurrio. Tres capturas de pantalla: el aviso, la respuesta, el final.
 *
 * Si todo pasa, deja el sello en .git/spoochie-prueba-real/<sha>. El pre-push no deja
 * subir un commit sin su sello. Con el arbol sucio no hay sello: lo probado no seria
 * lo que se sube.
 *
 *   bun scripts/prueba-real.ts             la prueba entera (unos 5 minutos, usa la pantalla)
 *   bun scripts/prueba-real.ts --dejar     no cierra nada al acabar, para mirar
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LAB = mkdtempSync("/tmp/sp-real-");
const HOME_A = join(LAB, "home-ana"), HOME_B = join(LAB, "home-bea");
const REPO_A = join(LAB, "repo-ana"), REPO_B = join(LAB, "repo-bea");
const RECIBIDO = join(LAB, "ana-recibio.txt");
const NUMERO = String(1000 + Math.floor(Math.random() * 9000));
const DEJAR = process.argv.includes("--dejar");
const CLAUDE = Bun.which("claude");
const SWIFT = join(ROOT, "scripts", "prueba-real", "ventana.swift");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const seg = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s`;
const informe: string[] = [];
function paso(ok: boolean, que: string, detalle = "") {
  const l = `${ok ? "  ok " : "FALLO"}  ${seg()}  ${que}${detalle ? `  (${detalle})` : ""}`;
  console.log(l); informe.push(l);
  appendFileSync(join(LAB, "informe.txt"), l + "\n");
}
const pids: number[] = [];
const ventanas: string[] = [];
const capturas: string[] = [];
const idsHilos: string[] = [];

function git(...a: string[]) { return spawnSync("git", a, { cwd: ROOT, encoding: "utf8" }).stdout.trim(); }
const json = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
async function hasta<T>(que: () => T | null | undefined | false, ms: number, cada = 1000): Promise<T | null> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { const v = que(); if (v) return v; await sleep(cada); }
  return null;
}
const hilos = (home: string): any[] => {
  const d = join(home, "threads");
  return existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".json")).map(f => json(join(d, f))).filter(Boolean) : [];
};
const log = (home: string) => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };

/** Todas las pantallas: el aviso sale en la que macOS quiera, no siempre en la principal. */
function captura(nombre: string) {
  const n = capturas.length + 1;
  const pantallas = Number(spawnSync("sh", ["-c", "system_profiler SPDisplaysDataType | grep -c Resolution"], { encoding: "utf8" }).stdout.trim()) || 1;
  const ps = Array.from({ length: pantallas }, (_, i) => join(LAB, `${n}-${nombre}${pantallas > 1 ? `-pantalla${i + 1}` : ""}.png`));
  spawnSync("screencapture", ["-x", ...ps]);
  for (const p of ps) if (existsSync(p)) capturas.push(p);
}

/** Los avisos que hay en pantalla antes de empezar no son de esta prueba. */
const avisos = () => spawnSync("pgrep", ["-f", "ObjC.import\\('Cocoa'\\)"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
const avisosPrevios = new Set(avisos());

/** Lo que ejecuta el demonio y el entorno que le pone launchd, sacados del plist que
 *  instalaria `register` en esa maquina. Ni un directorio mas del PATH de esta shell.
 *  Con `binario`, el demonio es ese ejecutable compilado, como en quien no tiene Bun. */
function entornoLaunchd(home: string, binario?: string): { cmd: string[]; env: Record<string, string> } {
  const arr = JSON.stringify(join(ROOT, "src", "arranque.ts"));
  const codigo = binario
    ? `const a = await import(${arr}); console.log(JSON.stringify({ cmd: [${JSON.stringify(binario)}, "daemon"], PATH: a.pathDelAgente([${JSON.stringify(binario)}], undefined, a.encontrarClaude()) }))`
    : `const a = await import(${arr}); const p = a.plistDeseado(); console.log(JSON.stringify({ cmd: [...p.match(/<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/)[1].matchAll(/<string>([^<]*)<\\/string>/g)].map(m => m[1]), PATH: p.match(/<key>PATH<\\/key><string>([^<]*)</)[1] }))`;
  const r = spawnSync("bun", ["-e", codigo], { encoding: "utf8", env: { ...process.env, SPOOCHIE_HOME: home } });
  let d: { cmd: string[]; PATH: string };
  try { d = JSON.parse(r.stdout); } catch { throw new Error(`no saco el demonio del plist: ${r.stdout}${r.stderr}`); }
  return { cmd: d.cmd, env: { PATH: d.PATH, HOME: process.env.HOME!, SPOOCHIE_HOME: home } };
}

function arrancarDemonio(home: string, binario?: string) {
  const { cmd, env } = entornoLaunchd(home, binario);
  const d = spawn(cmd[0], cmd.slice(1), { env, stdio: ["ignore", "ignore", "ignore"], detached: true });
  d.unref();
  if (d.pid) pids.push(d.pid);
  return env.PATH;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Una ventana de Terminal con un Claude de verdad, como la abre una persona. Sin
 *  crossSessionInbound: una persona no lo pone, y si hiciera falta, eso es un fallo. */
function ventanaClaude(nombre: string, home: string, repo: string, prompt: string) {
  const script = join(LAB, `${nombre}.command`);
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '\\033]0;sp-real ${nombre}\\007'`,
    `export SPOOCHIE_HOME=${sq(home)}`,
    `cd ${sq(repo)} || exit 1`,
    `echo $$ > ${sq(join(LAB, `${nombre}.pid`))}`,
    `tty > ${sq(join(LAB, `${nombre}.tty`))}`,
    `exec ${sq(CLAUDE!)} --plugin-dir ${sq(ROOT)} --dangerously-skip-permissions --name sp-real-${nombre} ${sq(prompt)}`,
    "",
  ].join("\n"));
  chmodSync(script, 0o700);
  spawnSync("open", ["-a", "Terminal", script]);
  ventanas.push(nombre);
  void contestarConfianza(nombre);
}

/** Lo que se ve en la pestana de Terminal de esa ventana, buscada por su tty. */
function pestana(nombre: string, accion: "leer" | "escribir", texto = ""): string {
  let tty = "";
  try { tty = readFileSync(join(LAB, `${nombre}.tty`), "utf8").trim(); } catch { return ""; }
  const hacer = accion === "leer" ? "return contents of t" : `do script ((ASCII character 27) & "${texto}") in t\nreturn ""`;
  const r = spawnSync("osascript", ["-e", `tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is "${tty}" then
${hacer}
end if
end repeat
end repeat
end tell`], { encoding: "utf8" });
  return r.stdout;
}

/**
 * Claude Code pregunta si te fias de un directorio la primera vez que entras. Una persona
 * lo contesta una vez en su repo; aqui los repos son nuevos en cada pasada. Se contesta
 * escribiendo en la pestana (flecha abajo + Return), sin pedir permiso de Accesibilidad.
 */
async function contestarConfianza(nombre: string) {
  const fin = Date.now() + 60_000;
  while (Date.now() < fin) {
    if (pestana(nombre, "leer").includes("trust this folder")) { pestana(nombre, "escribir", "[B"); return; }
    await sleep(1000);
  }
}

function repo(dir: string, ficheros: Record<string, string>) {
  for (const [f, c] of Object.entries(ficheros)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
  spawnSync("sh", ["-c", "git init -q && git add -A && git -c user.email=lab@sp -c user.name=lab commit -qm inicio"], { cwd: dir });
}

function recoger() {
  if (DEJAR) { console.log(`\n--dejar: todo sigue vivo en ${LAB}`); return; }
  for (const n of ventanas) { const p = json(join(LAB, `${n}.pid`)); if (p) try { process.kill(p) } catch {} }
  for (const h of [HOME_A, HOME_B]) {
    const lock = join(h, "daemon.pid");
    if (existsSync(lock)) try { process.kill(Number(readFileSync(lock, "utf8").trim())) } catch {}
  }
  for (const p of pids) try { process.kill(p) } catch {}
  // El aviso es un osascript hijo del demonio y le sobrevive: sin esto queda en pantalla.
  for (const p of avisos()) if (!avisosPrevios.has(p)) try { process.kill(p) } catch {}
  // El Claude aparte de Bea se lanza con --name spoochie-<id>.
  for (const id of idsHilos) spawnSync("pkill", ["-f", `--name spoochie-${id}`]);
}

async function main() {
  if (process.platform !== "darwin") { console.error("la prueba real usa la pantalla de un Mac"); process.exit(2); }
  if (!CLAUDE) { console.error("no hay claude en el PATH"); process.exit(2); }
  if (spawnSync("swift", [SWIFT, "permiso"], { encoding: "utf8" }).stdout.trim() !== "si") {
    console.error("macOS no deja a este proceso pulsar el aviso. Dale permiso de Accesibilidad a la app de terminal");
    console.error("desde la que corres esto (Ajustes > Privacidad y seguridad > Accesibilidad) y vuelve a lanzarla.");
    process.exit(2);
  }
  const sha = git("rev-parse", "HEAD");
  const sucio = git("status", "--porcelain", "--untracked-files=no");
  console.log(`prueba real sobre ${sha.slice(0, 7)}${sucio ? " (arbol sucio: no habra sello)" : ""}, laboratorio en ${LAB}\n`);

  // 1. Dos repos. La respuesta solo esta en el de Bea.
  repo(REPO_A, { "src/cliente.ts": "import { LIMITE_REINTENTOS } from './config';\nexport const reintentar = (n: number) => n < LIMITE_REINTENTOS;\n" });
  repo(REPO_B, { "src/config.ts": `// Cuantas veces se reintenta una llamada antes de rendirse.\nexport const LIMITE_REINTENTOS = ${NUMERO};\n` });
  mkdirSync(HOME_A, { recursive: true, mode: 0o700 }); mkdirSync(HOME_B, { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME_A, "config.json"), JSON.stringify({ human: "Ana" }), { mode: 0o600 });

  // 2. Bea no tiene Bun: usa el binario compilado, como lo baja el hook de la release.
  //    Se compila de este arbol, con el mismo comando que el workflow de release.
  const version = json(join(ROOT, ".claude-plugin", "plugin.json")).version;
  const binB = join(HOME_B, "bin", `spoochie-${version}`);
  mkdirSync(join(HOME_B, "bin"), { recursive: true, mode: 0o700 });
  const comp = spawnSync("bun", ["build", "--compile", join(ROOT, "src", "cli.ts"), "--outfile", binB], { encoding: "utf8" });
  paso(comp.status === 0 && existsSync(binB), "el binario de Bea compila", comp.status === 0 ? `spoochie-${version}` : comp.stderr.trim().slice(-300));
  if (!existsSync(binB)) throw new Error("sin binario");

  // 3. Los demonios, con el entorno de launchd. Antes que las sesiones: el hook los encuentra vivos.
  const pathA = arrancarDemonio(HOME_A), pathB = arrancarDemonio(HOME_B, binB);
  const vivos = await hasta(() => existsSync(join(HOME_A, "daemon.sock")) && existsSync(join(HOME_B, "daemon.sock")), 20_000, 300);
  paso(Boolean(vivos), "los dos demonios arrancan con el PATH del plist", `Ana ${pathA} · Bea ${pathB}`);
  if (!vivos) throw new Error("sin demonios");

  // 3. Ana invita a Bea, sin Slack: la linea que se manda a mano.
  const inv = spawnSync(join(ROOT, "bin", "spoochie"), ["invite", "--name", "Bea"], { encoding: "utf8", env: { ...process.env, SPOOCHIE_HOME: HOME_A } });
  const blob = inv.stdout.match(/eyJ[A-Za-z0-9_\-=+/]+/)?.[0];
  paso(Boolean(blob), "Ana saca una invitacion", inv.status === 0 ? "" : inv.stderr.trim());
  if (!blob) throw new Error("sin invitacion");

  // 4. Bea abre Claude y pega la invitacion, como dice el README.
  ventanaClaude("bea", HOME_B, REPO_B, `/spoochie:join ${blob}`);
  const contacto = await hasta(() => Object.values(json(join(HOME_A, "config.json"))?.contacts ?? {}).find((c: any) => c.name === "Bea" && c.npub), 180_000, 2000) as any;
  paso(Boolean(contacto), "la clave de Bea llega a Ana por los reles", contacto ? `npub ${contacto.npub.slice(0, 12)}...` : "Ana no tiene a Bea con npub");
  const sesionB = await hasta(() => existsSync(join(HOME_B, "sessions")) && readdirSync(join(HOME_B, "sessions")).length > 0, 60_000);
  paso(Boolean(sesionB), "la sesion de Bea queda registrada");
  if (!contacto) throw new Error("sin alta");

  // 5. Ana le pide a su Claude, en lenguaje normal, que le pregunte a Bea.
  ventanaClaude("ana", HOME_A, REPO_A,
    `Usa spoochie para preguntarle a @bea que valor tiene LIMITE_REINTENTOS en src/config.ts de su repo; ` +
    `yo solo uso la constante en src/cliente.ts y no veo su codigo. Cuando te conteste, escribe solo ese numero ` +
    `en ${RECIBIDO} y cierra el spoochie.`);
  const abierto = await hasta(() => hilos(HOME_A)[0], 240_000, 2000);
  paso(Boolean(abierto), "el Claude de Ana abre el spoochie", abierto ? `hilo ${abierto.id}, ${abierto.transporte ?? "?"}` : "");
  if (!abierto) throw new Error("Ana no abrio");
  idsHilos.push(abierto.id);
  const llega = await hasta(() => hilos(HOME_B).find(t => t.id === abierto.id), 120_000, 1000);
  paso(Boolean(llega), "el sobre llega al demonio de Bea");
  if (!llega) throw new Error("no llego");

  // 6. El aviso en pantalla, y el clic de verdad en "Que pase" (el boton de la derecha).
  const aviso = await hasta(() => {
    const r = spawnSync("swift", [SWIFT, "buscar"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().split(" ").map(Number) : null;
  }, 60_000, 1500);
  captura("aviso");
  paso(Boolean(aviso), "el aviso sale en la pantalla de Bea", aviso ? `en ${aviso.join(",")}` : "ninguna ventana de osascript de 440 de ancho");
  if (!aviso) throw new Error("sin aviso");
  const [x, y, w, h] = aviso;
  // Botones: 28 de alto, con el borde de abajo a MARGEN-8 = 18 del pie, el de aceptar pegado al margen derecho (26).
  spawnSync("swift", [SWIFT, "pulsar", String(x + w - 26 - 40), String(y + h - 18 - 14)]);
  const aceptado = await hasta(() => {
    const t = hilos(HOME_B).find(t => t.id === abierto.id);
    return t && t.state !== "pending" ? t : null;
  }, 30_000, 500);
  paso(Boolean(aceptado), "el clic llega al demonio como Que pase", aceptado ? `estado ${aceptado.state}` : (log(HOME_B).match(/.*sin respuesta.*|.*button returned.*/g)?.slice(-1)[0] ?? "sigue pending"));
  if (!aceptado) throw new Error("clic perdido");

  // 7. La ventana del Claude aparte de Bea arranca (aqui fallaba "claude: not found").
  const aparte = await hasta(() => readdirSync(join(HOME_B, "sessions")).map(f => json(join(HOME_B, "sessions", f)))
    .find(s => s?.aparte === abierto.id && s.socket && !s.socket.startsWith("(")), 90_000, 1000);
  paso(Boolean(aparte), "el Claude aparte de Bea arranca y se registra", aparte ? `pid ${aparte.pid}` : (log(HOME_B).match(/.*aparte.*/g)?.slice(-1)[0] ?? ""));

  // 8. Bea contesta y la respuesta llega a la sesion de Ana: Ana escribe el numero.
  const recibido = await hasta(() => existsSync(RECIBIDO) && readFileSync(RECIBIDO, "utf8").trim(), 300_000, 2000);
  captura("respuesta");
  paso(recibido === NUMERO, "la respuesta de Bea llega al Claude de Ana", `esperaba ${NUMERO}, Ana escribio ${recibido || "nada"}`);

  // 9. El cierre llega a los dos lados.
  const cerrado = await hasta(() => {
    const a = hilos(HOME_A).find(t => t.id === abierto.id), b = hilos(HOME_B).find(t => t.id === abierto.id);
    return (!a || a.state === "closed") && (!b || b.state === "closed");
  }, 120_000, 2000);
  captura("final");
  paso(Boolean(cerrado), "el spoochie queda cerrado en los dos lados");

  const fallos = informe.filter(l => l.startsWith("FALLO")).length;
  console.log(`\n${fallos ? `${fallos} fallos` : "Conversacion real completa"}. Capturas:\n${capturas.map(c => "  " + c).join("\n")}`);
  if (fallos) return 1;
  if (sucio) { console.log("\nArbol sucio: no dejo sello. Commitea y repite."); return 1; }
  const dir = join(ROOT, git("rev-parse", "--git-common-dir"), "spoochie-prueba-real");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha), [`${new Date().toISOString()} ${sha}`, ...informe, ...capturas].join("\n") + "\n");
  console.log(`\nSello: ${join(dir, sha)}`);
  return 0;
}

let codigo = 1;
try { codigo = await main(); }
catch (e: any) {
  paso(false, "la prueba se para", e.message);
  captura("donde-se-paro");
  console.log(`\nCapturas:\n${capturas.map(c => "  " + c).join("\n")}\nLogs: ${HOME_A}/daemon.log, ${HOME_B}/daemon.log`);
}
finally { recoger(); }
process.exit(codigo);
