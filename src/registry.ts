import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR, ensureDirs, escribirAtomico } from "./paths.ts";

export type SessionRecord = {
  sessionId: string;
  name: string;
  cwd: string;
  socket: string;
  token: string;
  pid: number;
  startedAt: number;
  /** Si es un Claude aparte, el id del spoochie que atiende. No se le asigna otro. */
  aparte?: string;
  /** Ultima vez que la persona escribio en esa sesion (mtime del registro, que el hook
   *  UserPromptSubmit toca). Es lo que dice "la terminal en la que estoy trabajando". */
  activeAt?: number;
};

/** El id acaba siendo un nombre de fichero. Cuando el hook no trae session_id se
 *  usa la ruta del socket, que lleva barras: sin limpiar, escribir el registro
 *  petaba con ENOENT y la sesion se quedaba sin dar de alta sin que nadie lo viera. */
const nombreSeguro = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "sesion";
const file = (id: string) => join(SESSIONS_DIR, `${nombreSeguro(id)}.json`);

export function register(rec: SessionRecord) {
  ensureDirs();
  escribirAtomico(file(rec.sessionId), JSON.stringify(rec, null, 2));
}

export function unregister(sessionId: string) {
  try { unlinkSync(file(sessionId)); } catch {}
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Un registro con permisos flojos no se lee.
 *
 * Cada fichero lleva el token del buzon de esa sesion, que es lo que permite entregarle
 * mensajes sin que salte el dialogo de aprobacion. Se escribe con 0600, pero si alguien
 * lo afloja (un rsync, un backup, un umask raro) el token queda legible para otros
 * usuarios de la maquina. Mejor negarse y decirlo que seguir como si nada.
 */
export function permisosFlojos(ruta: string): boolean {
  try { return (statSync(ruta).mode & 0o077) !== 0; } catch { return false; }
}

/** Sessions whose process is still running. Sweeps records left by crashed sessions. */
export function liveSessions(): SessionRecord[] {
  ensureDirs();
  const out: SessionRecord[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = join(SESSIONS_DIR, f);
    if (permisosFlojos(p)) { console.error(`spoochie: ignoro ${f}, tiene permisos abiertos (chmod 600)`); continue; }
    let rec: SessionRecord;
    try { rec = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    // Un Claude aparte recibe por stdin del demonio: no tiene socket que comprobar.
    if (!alive(rec.pid) || (!rec.aparte && !existsSync(rec.socket))) { try { unlinkSync(p); } catch {} continue; }
    try { rec.activeAt = Math.max(rec.startedAt, statSync(p).mtimeMs); } catch { rec.activeAt = rec.startedAt; }
    out.push(rec);
  }
  // La mas activa primera: la que tiene el ultimo prompt del humano, no la ultima en arrancar.
  return out.sort((a, b) => (b.activeAt ?? b.startedAt) - (a.activeAt ?? a.startedAt));
}

export function findSession(needle: string): SessionRecord[] {
  const live = liveSessions();
  const n = needle.toLowerCase();
  const exact = live.filter(s => s.sessionId === needle || s.name.toLowerCase() === n);
  if (exact.length) return exact;
  return live.filter(s => s.name.toLowerCase().includes(n) || s.cwd.toLowerCase().includes(n) || s.sessionId.startsWith(needle));
}
