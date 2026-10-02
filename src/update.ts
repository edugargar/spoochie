/**
 * Knowing whether a newer version has been published. Claude Code does not update
 * plugins on its own: someone has to type `/plugin update`. So the daemon checks the
 * latest GitHub release (no token, 60 calls per hour per IP; here one every 6 h), says
 * so once a day in the thread, and `doctor` shows it.
 */
import { VERSION, newerThan } from "./version.ts";
import { ORIGIN as REPO, PLUGIN } from "./origin.ts";
import { envVar } from "./paths.ts";
const EVERY_MS = 6 * 60 * 60 * 1000;
let cache: { at: number; version: string | null } | null = null;

export async function latestPublished(): Promise<string | null> {
  if (envVar("SPOOCHIE_OFFLINE", "SPOOCHIE_SIN_RED")) return null;
  if (cache && Date.now() - cache.at < EVERY_MS) return cache.version;
  let version: string | null = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": `spoochie/${VERSION}` }, signal: AbortSignal.timeout(5000) });
    if (r.ok) version = String((await r.json()).tag_name ?? "").replace(/^v/, "") || null;
  } catch {}
  cache = { at: Date.now(), version };
  return version;
}

/** The line that says so, or null if we are up to date (or it could not be found out). */
export async function newVersionNotice(): Promise<string | null> {
  const u = await latestPublished();
  if (!u || !newerThan(u, VERSION)) return null;
  return `spoochie ${u} is out (this machine has ${VERSION}): /plugin update ${PLUGIN} and restart a session`;
}
