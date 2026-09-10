import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";

/** SPOOCHIE_HOME aisla todo el estado. Los tests lo usan: os.homedir() en Bun no
 *  respeta $HOME, asi que sin esto un test escribe en tu ~/.claude de verdad. */
export const ROOT = process.env.SPOOCHIE_HOME ?? join(homedir(), ".claude", "spoochie");

/** El proyecto se llamo "spochie" hasta la 0.5.4. El estado (config con el token y las
 *  claves, agenda, hilos) vivia en ~/.claude/spochie: la primera vez que arranca la
 *  version nueva se lo lleva tal cual al directorio nuevo, para que nadie tenga que
 *  volver a darse de alta. Solo si el nuevo no existe todavia. */
export function migrarEstado(viejo: string, nuevo: string): boolean {
  if (!existsSync(viejo) || existsSync(nuevo)) return false;
  try { renameSync(viejo, nuevo); return true; } catch { return false; }
}
if (!process.env.SPOOCHIE_HOME) migrarEstado(join(homedir(), ".claude", "spochie"), ROOT);
export const SESSIONS_DIR = join(ROOT, "sessions");
export const THREADS_DIR = join(ROOT, "threads");
export const DAEMON_SOCK = join(ROOT, "daemon.sock");
export const DAEMON_LOCK = join(ROOT, "daemon.pid");
export const DAEMON_LOG = join(ROOT, "daemon.log");
export const OUTBOX_FILE = join(ROOT, "outbox.json");

export function ensureDirs() {
  for (const d of [ROOT, SESSIONS_DIR, THREADS_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

/**
 * El entorno con el que arranca un proceso hijo: solo lo que hace falta.
 *
 * Los dos procesos que spoochie lanza (el demonio, y el Claude aparte en modo fondo)
 * heredaban `process.env` entero. Eso significa que si la CLI arranca el demonio desde
 * una sesion de Claude Code, la sesion le pasa CLAUDE_CODE_MESSAGING_SOCKET y
 * CLAUDE_CODE_MESSAGING_TOKEN, que son las credenciales del buzon de ESA sesion, y el
 * demonio se las pasaba al aparte. Un proceso que atiende texto de otra persona no
 * tiene por que tener a mano la llave del buzon donde tu estas trabajando.
 *
 * En modo ventana esto ya pasaba: el script exporta PATH y las SPOOCHIE_ y nada mas.
 * Esta funcion es lo mismo para los que no van por un script.
 */
const HEREDABLES = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  // Que `claude` y `bun` encuentren los certificados en maquinas con proxy corporativo.
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  // Donde vive la configuracion de Claude Code, si no es la de por defecto.
  "CLAUDE_CONFIG_DIR",
];
/** Prefijos que si pasan enteros. `CLAUDE_` NO: ahi viven las del buzon. */
const PREFIJOS_HEREDABLES = ["SPOOCHIE_", "ANTHROPIC_"];

export function entornoLimpio(extra: Record<string, string | undefined> = {}, base = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (HEREDABLES.includes(k) || PREFIJOS_HEREDABLES.some(p => k.startsWith(p))) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}
