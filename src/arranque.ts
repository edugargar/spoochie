/**
 * Como se arranca el demonio, y como se sabe que sigue vivo.
 *
 * Antes lo levantaba el primer hook SessionStart y moria con el reinicio de la
 * maquina; el sintoma de un demonio muerto era "no llega nada". Ahora en macOS se
 * registra en launchd con KeepAlive, y escribe un latido cada 20 s que `doctor` mide.
 * El hook sigue sirviendo de red: si no hay latido, arranca lo que haga falta.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync, openSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, DAEMON_LOG, DAEMON_LOCK, ensureDirs } from "./paths.ts";
import { VERSION } from "./version.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `bun build --compile` mete los ficheros en un sistema virtual. Si estamos ahi,
 *  el ejecutable es spoochie mismo y el demonio se arranca como subcomando. */
export const COMPILADO = import.meta.path.includes("$bunfs");

export const LATIDO = join(ROOT, "latido");
export const LATIDO_MS = 20_000;
export const LABEL = "dev.spoochie.spoochied";

export function comandoDemonio(): string[] {
  // Para las pruebas: un demonio que no arranca, a proposito y sin depender del PATH.
  if (process.env.SPOOCHIE_DAEMON_CMD) return process.env.SPOOCHIE_DAEMON_CMD.split(" ");
  if (COMPILADO) return [process.execPath, "daemon"];
  const bun = (() => { try { return execFileSync("which", ["bun"], { encoding: "utf8" }).trim(); } catch { return "bun"; } })();
  return [bun, "run", join(HERE, "daemon.ts")];
}

/**
 * El latido lleva la version del demonio que late. `doctor` corre con el codigo del
 * plugin recien actualizado, pero el demonio bajo launchd sigue siendo el que arranco
 * antes de actualizar: sin esto, doctor decia "0.9.0" con un demonio 0.7.1 corriendo.
 */
export function latir(version: string = VERSION) {
  try {
    if (!existsSync(LATIDO) || readFileSync(LATIDO, "utf8") !== version) writeFileSync(LATIDO, version, { mode: 0o600 });
    const now = new Date();
    utimesSync(LATIDO, now, now);
  } catch {}
}

/** Version del demonio que late, o null si no late o es anterior a 0.9.1 (latido vacio). */
export function versionLatido(): string | null {
  try { return readFileSync(LATIDO, "utf8").trim() || null; } catch { return null; }
}

/** Segundos desde el ultimo latido, o null si nunca lo hubo. */
export function edadLatido(): number | null {
  try { return (Date.now() - statSync(LATIDO).mtimeMs) / 1000; } catch { return null; }
}

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function plistDeseado(): string {
  const args = comandoDemonio().map(a => `      <string>${a}</string>`).join("\n");
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Lo escribe spoochie (register / join). Se reescribe solo si cambia la ruta del plugin. -->
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${path}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${DAEMON_LOG}</string>
  <key>StandardErrorPath</key><string>${DAEMON_LOG}</string>
</dict></plist>
`;
}

const uid = () => { try { return execFileSync("id", ["-u"], { encoding: "utf8" }).trim(); } catch { return "501"; } };
const launchctl = (args: string[]) => { try { execFileSync("launchctl", args, { stdio: "ignore" }); return true; } catch { return false; } };

export function launchdInstalado(): boolean {
  return process.platform === "darwin" && existsSync(plistPath()) && !process.env.SPOOCHIE_HOME;
}

/** Deja el demonio bajo launchd. Idempotente: si el plist ya dice lo mismo, no toca
 *  nada. Si cambia (el plugin se actualizo y la ruta es otra), lo recarga. Con
 *  SPOOCHIE_HOME puesto no se instala nada: eso es un laboratorio, no tu maquina. */
/** La version del plugin que hay en una ruta de la cache (.../spoochie/0.5.1/...). */
export function versionDeRuta(texto: string): string | null {
  return /\/spoochie\/(\d+\.\d+\.\d+)\//.exec(texto)?.[1] ?? null;
}
export function masNueva(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** El LaunchAgent de cuando esto se llamaba spochie: si sigue ahi, corre un demonio
 *  viejo que lee el mismo Slack y entregaria todo dos veces. Se apaga y se borra. */
export function retirarLaunchdViejo(): boolean {
  const viejo = join(homedir(), "Library", "LaunchAgents", "dev.spochie.spochied.plist");
  if (!existsSync(viejo)) return false;
  launchctl(["bootout", `gui/${uid()}/dev.spochie.spochied`]);
  try { unlinkSync(viejo); } catch {}
  return true;
}

/** El pid del candado, si ese proceso sigue vivo. */
export function pidVivo(): number | null {
  try { const pid = Number(readFileSync(DAEMON_LOCK, "utf8").trim()); if (pid) { process.kill(pid, 0); return pid; } } catch {}
  return null;
}

/**
 * Apaga el demonio que tiene el candado y espera a que lo suelte (hasta 3 s; luego
 * SIGKILL). Hace falta porque un demonio que arranco un hook va suelto: launchd no lo
 * conoce, `bootout` no lo toca, y el que launchd arranca muere al instante con "ya esta
 * corriendo" y se reintenta cada 10 s para siempre. Visto en directo: tras actualizar
 * a 0.9.2, el 0.7.1 de la vispera siguio latiendo un dia entero con el plist ya nuevo.
 */
export function apagarDemonio(): boolean {
  const pid = pidVivo();
  if (!pid) return false;
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  const hasta = Date.now() + 3000;
  while (Date.now() < hasta) { try { process.kill(pid, 0); execFileSync("sleep", ["0.1"]); } catch { return true; } }
  try { process.kill(pid, "SIGKILL"); } catch {}
  return true;
}

/** El demonio que late es mas viejo que este plugin (o tan viejo que no dice version). */
export function demonioAtrasado(): boolean {
  if (!pidVivo()) return false;
  const late = versionLatido();
  return late === null || masNueva(VERSION, late);
}

export function instalarLaunchd(): "instalado" | "actualizado" | "igual" | "no" {
  if (process.platform !== "darwin" || process.env.SPOOCHIE_HOME) return "no";
  ensureDirs();
  if (retirarLaunchdViejo()) console.error("spoochie: apagado y retirado el demonio antiguo (spochie)");
  const deseado = plistDeseado();
  const p = plistPath();
  const habia = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (habia === deseado) {
    // El plist ya es este, pero el proceso que late puede ser el de antes de actualizar.
    if (!demonioAtrasado()) return "igual";
    apagarDemonio();
    launchctl(["kickstart", `gui/${uid()}/${LABEL}`]);
    return "actualizado";
  }
  // Una sesion con el plugin viejo no degrada el demonio: visto en directo, un hook
  // de 0.5.1 devolvio launchd a 0.5.1 a los 80 s de haberlo subido, en mitad de una
  // prueba. Solo se sustituye por una version igual o mas nueva.
  const vieja = habia ? versionDeRuta(habia) : null, mia = versionDeRuta(deseado);
  if (vieja && mia && masNueva(vieja, mia)) return "no";
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, deseado, { mode: 0o644 });
  // Se apaga el de antes, venga de launchd (bootout) o de un hook (suelto, con el
  // candado puesto): si no, el nuevo muere al instante y launchd lo reintenta sin fin.
  if (habia !== null) launchctl(["bootout", `gui/${uid()}/${LABEL}`]);
  apagarDemonio();
  launchctl(["bootstrap", `gui/${uid()}`, p]) || launchctl(["load", "-w", p]);
  return habia === null ? "instalado" : "actualizado";
}

/** Arranca el demonio como toque: por launchd si esta, a mano si no. */
export function arrancarDemonio() {
  ensureDirs();
  if (launchdInstalado()) {
    if (launchctl(["kickstart", `gui/${uid()}/${LABEL}`])) return;
  }
  const out = openSync(DAEMON_LOG, "a");
  const [cmd, ...args] = comandoDemonio();
  spawn(cmd, args, { detached: true, stdio: ["ignore", out, out] }).unref();
}
