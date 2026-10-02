import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync, statSync, chmodSync, writeFileSync, unlinkSync } from "node:fs";

/** SPOOCHIE_HOME isolates all state. The tests use it: os.homedir() in Bun does not
 *  honour $HOME, so without this a test writes into your real ~/.claude. */
export const ROOT = process.env.SPOOCHIE_HOME ?? join(homedir(), ".claude", "spoochie");

/** The project was called "spochie" up to 0.5.4. The state (config with the token and
 *  the keys, contacts, threads) lived in ~/.claude/spochie: the first time the new
 *  version starts it moves it as is to the new directory, so nobody has to join again.
 *  Only if the new one does not exist yet. */
export function migrateState(from: string, to: string): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  try { renameSync(from, to); return true; } catch { return false; }
}
if (!process.env.SPOOCHIE_HOME) migrateState(join(homedir(), ".claude", "spochie"), ROOT);
export const SESSIONS_DIR = join(ROOT, "sessions");
export const THREADS_DIR = join(ROOT, "threads");
export const DAEMON_SOCK = join(ROOT, "daemon.sock");
export const DAEMON_LOCK = join(ROOT, "daemon.pid");
export const DAEMON_LOG = join(ROOT, "daemon.log");
export const OUTBOX_FILE = join(ROOT, "outbox.json");

/**
 * The state directories, and their permissions.
 *
 * `mkdirSync`'s `mode` only applies when the directory is created. One that already
 * existed open (created by an older version, or with an odd umask, or loosened by a
 * backup) stayed open forever: inside are the config with the three keys, the daemon
 * socket through which a tunnel opens without asking, the threads and the spool.
 * `spoochie doctor` said so, but doctor runs once something is already broken.
 *
 * So it is checked and closed on every start. It is the person's own directory, and
 * setting it to 700 takes nothing away from anyone.
 */
export function ensureDirs() {
  for (const d of [ROOT, SESSIONS_DIR, THREADS_DIR]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try { if ((statSync(d).mode & 0o077) !== 0) chmodSync(d, 0o700); } catch {}
  }
}

/**
 * The environment a child process starts with: only what it needs.
 *
 * The two processes spoochie launches (the daemon, and the aside Claude in background
 * mode) inherited the whole `process.env`. That means that if the CLI starts the daemon
 * from a Claude Code session, the session hands it CLAUDE_CODE_MESSAGING_SOCKET and
 * CLAUDE_CODE_MESSAGING_TOKEN, the inbox credentials of THAT session, and the daemon
 * passed them on to the aside. A process that handles another person's text has no
 * business holding the key to the inbox you are working in.
 *
 * Window mode already did this: the script exports PATH and the SPOOCHIE_ ones and
 * nothing else. This function is the same for the ones that do not go through a script.
 */
const INHERITED = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  // So `claude` and `bun` find the certificates on machines behind a corporate proxy.
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  // Where Claude Code's configuration lives, if it is not the default one.
  "CLAUDE_CONFIG_DIR",
];
/** Prefixes that do pass through whole. `CLAUDE_` does NOT: the inbox ones live there. */
const INHERITED_PREFIXES = ["SPOOCHIE_", "ANTHROPIC_"];

/** Environment variables had Spanish names up to 0.9.10 (`SPOOCHIE_VENTANA=fondo`). The
 *  English name wins; the old name, and its old values, still work. */
const OLD_VALUES: Record<string, string> = { fondo: "background", ventana: "window", dialogo: "dialog" };
export function envVar(name: string, old: string): string | undefined {
  const v = process.env[name] ?? process.env[old];
  return v === undefined ? undefined : OLD_VALUES[v] ?? v;
}

export function cleanEnv(extra: Record<string, string | undefined> = {}, base = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (INHERITED.includes(k) || INHERITED_PREFIXES.some(p => k.startsWith(p))) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * Writing a state file without leaving it half done.
 *
 * `writeFileSync` truncates and then writes, so a process that dies in between (a
 * SIGKILL, a power cut, the OOM killer) leaves the file cut short. Measured with the
 * config: cut in half, `load` returned the default config without a word and the next
 * `save` wrote over it, so the three keys and all the contacts were lost silently. The
 * same `writeFileSync` was in the threads, the outbox and the seen lists.
 *
 * It writes alongside and renames. A rename is atomic within the same disk: a reader
 * sees the whole old file or the whole new one, never half of either.
 * The temporary suffix stays `.nuevo`; tests look for it.
 */
export function writeAtomic(path: string, text: string, mode = 0o600) {
  const temp = `${path}.nuevo`;
  writeFileSync(temp, text, { mode });
  try {
    renameSync(temp, path);
  } catch (e) {
    try { unlinkSync(temp); } catch {}
    throw e;
  }
}
