/**
 * Saber si hay una version mas nueva publicada. Claude Code no actualiza los plugins
 * solo: alguien tiene que escribir `/plugin update`. Asi que el demonio mira la ultima
 * release en GitHub (sin token, 60 llamadas por hora por IP; aqui una cada 6 h) y lo
 * dice una vez al dia en el hilo, y `doctor` lo ensena.
 */
import { VERSION, newerThan } from "./version.ts";
import { ORIGIN as REPO, PLUGIN } from "./origin.ts";
import { envVar } from "./paths.ts";
const CADA_MS = 6 * 60 * 60 * 1000;
let cache: { cuando: number; version: string | null } | null = null;

export async function latestPublished(): Promise<string | null> {
  if (envVar("SPOOCHIE_OFFLINE", "SPOOCHIE_SIN_RED")) return null;
  if (cache && Date.now() - cache.cuando < CADA_MS) return cache.version;
  let version: string | null = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": `spoochie/${VERSION}` }, signal: AbortSignal.timeout(5000) });
    if (r.ok) version = String((await r.json()).tag_name ?? "").replace(/^v/, "") || null;
  } catch {}
  cache = { cuando: Date.now(), version };
  return version;
}

/** La linea para decirlo, o null si estamos al dia (o no se pudo saber). */
export async function newVersionNotice(): Promise<string | null> {
  const u = await latestPublished();
  if (!u || !newerThan(u, VERSION)) return null;
  return `hay spoochie ${u} (esta maquina tiene ${VERSION}): /plugin update ${PLUGIN} y reiniciar una sesion`;
}
