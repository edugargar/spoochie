import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR, ensureDirs, writeAtomic } from "./paths.ts";

export type SessionRecord = {
  sessionId: string;
  name: string;
  cwd: string;
  socket: string;
  token: string;
  pid: number;
  startedAt: number;
  /** If this is an aside Claude, the id of the spoochie it handles. It is never given another.
   *  The field name stays `aparte`: it is written to sessions/*.json. */
  aparte?: string;
  /** Last time the person typed in that session (the record's mtime, which the
   *  UserPromptSubmit hook touches). It is what says "the terminal I am working in". */
  activeAt?: number;
};

/** The id ends up as a file name. When the hook brings no session_id the socket path
 *  is used, which has slashes: without cleaning, writing the record blew up with ENOENT
 *  and the session went unregistered without anyone noticing.
 *  The fallback name stays "sesion" so existing record files keep their names. */
const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "sesion";
const file = (id: string) => join(SESSIONS_DIR, `${safeName(id)}.json`);

export function register(rec: SessionRecord) {
  ensureDirs();
  writeAtomic(file(rec.sessionId), JSON.stringify(rec, null, 2));
}

export function unregister(sessionId: string) {
  try { unlinkSync(file(sessionId)); } catch {}
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * A record with loose permissions is not read.
 *
 * Each file carries that session's inbox token, which is what lets messages be
 * delivered to it without the approval dialog popping up. It is written with 0600, but
 * if someone loosens it (an rsync, a backup, an odd umask) the token becomes readable by
 * other users on the machine. Better to refuse and say so than to carry on as if nothing.
 */
export function loosePermissions(path: string): boolean {
  try { return (statSync(path).mode & 0o077) !== 0; } catch { return false; }
}

/** Sessions whose process is still running. Sweeps records left by crashed sessions. */
export function liveSessions(): SessionRecord[] {
  ensureDirs();
  const out: SessionRecord[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = join(SESSIONS_DIR, f);
    if (loosePermissions(p)) { console.error(`spoochie: ignoring ${f}, its permissions are open (chmod 600)`); continue; }
    let rec: SessionRecord;
    try { rec = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    // An aside Claude receives through stdin from the daemon: it has no socket to check.
    if (!alive(rec.pid) || (!rec.aparte && !existsSync(rec.socket))) { try { unlinkSync(p); } catch {} continue; }
    try { rec.activeAt = Math.max(rec.startedAt, statSync(p).mtimeMs); } catch { rec.activeAt = rec.startedAt; }
    out.push(rec);
  }
  // Most active first: the one with the human's latest prompt, not the latest to start.
  return out.sort((a, b) => (b.activeAt ?? b.startedAt) - (a.activeAt ?? a.startedAt));
}

export function findSession(needle: string): SessionRecord[] {
  const live = liveSessions();
  const n = needle.toLowerCase();
  const exact = live.filter(s => s.sessionId === needle || s.name.toLowerCase() === n);
  if (exact.length) return exact;
  return live.filter(s => s.name.toLowerCase().includes(n) || s.cwd.toLowerCase().includes(n) || s.sessionId.startsWith(needle));
}
