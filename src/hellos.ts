/**
 * Cuando toca mandar mi clave Nostr por Slack a un contacto que no tiene la suya.
 *
 * Era "una vez por contacto y arranque", en memoria: con cada reinicio de Claude Code
 * el demonio arranca de nuevo y vuelve a mandar el DM. Visto en directo: dos DMs a la
 * misma persona en 35 segundos. Ahora se apunta en disco cuando se mando a cada uno y
 * no se repite hasta pasado un dia, que es lo que tarda en actualizar quien no lo ha hecho.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs } from "./paths.ts";

export const HELLOS_FILE = join(ROOT, "holas.json");
export const HELLO_EVERY_MS = 24 * 3600 * 1000;

function leer(): Record<string, number> {
  try { return existsSync(HELLOS_FILE) ? JSON.parse(readFileSync(HELLOS_FILE, "utf8")) : {}; } catch { return {}; }
}

/** True si a este contacto no se le ha mandado la clave en el ultimo dia; y lo apunta. */
export function helloDue(id: string, ahora = Date.now()): boolean {
  const h = leer();
  if (h[id] && ahora - h[id] < HELLO_EVERY_MS) return false;
  h[id] = ahora;
  ensureDirs();
  try { writeFileSync(HELLOS_FILE, JSON.stringify(h), { mode: 0o600 }); } catch {}
  return true;
}

/** Ya tiene clave: no hace falta recordar nada de el. */
export function forgetHello(id: string) {
  const h = leer();
  if (!(id in h)) return;
  delete h[id];
  try { writeFileSync(HELLOS_FILE, JSON.stringify(h), { mode: 0o600 }); } catch {}
}
