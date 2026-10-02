/**
 * How the daemon is started, and how we know it is still alive.
 *
 * It used to be started by the first SessionStart hook and died when the machine
 * rebooted; the symptom of a dead daemon was "nothing arrives". Now on macOS it is
 * registered with launchd with KeepAlive, and it writes a heartbeat every 20 s that
 * `doctor` measures. The hook is still the safety net: with no heartbeat, it starts
 * whatever is needed.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync, openSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, DAEMON_LOG, DAEMON_LOCK, ensureDirs, cleanEnv } from "./paths.ts";
import { VERSION } from "./version.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `bun build --compile` puts the files in a virtual filesystem. If we are in there,
 *  the executable is spoochie itself and the daemon starts as a subcommand. */
export const COMPILED = import.meta.path.includes("$bunfs");

// The file name on disk stays Spanish: older daemons and `doctor` read it.
export const HEARTBEAT = join(ROOT, "latido");
export const HEARTBEAT_MS = 20_000;
export const LABEL = "dev.spoochie.spoochied";

export function daemonCommand(): string[] {
  // For the tests: a daemon that fails to start, on purpose and without depending on PATH.
  if (process.env.SPOOCHIE_DAEMON_CMD) return process.env.SPOOCHIE_DAEMON_CMD.split(" ");
  if (COMPILED) return [process.execPath, "daemon"];
  const bun = (() => { try { return execFileSync("which", ["bun"], { encoding: "utf8" }).trim(); } catch { return "bun"; } })();
  return [bun, "run", join(HERE, "daemon.ts")];
}

/**
 * The heartbeat carries the version of the daemon that writes it. `doctor` runs with the
 * freshly updated plugin code, but the daemon under launchd is still the one that started
 * before the update: without this, doctor said "0.9.0" with a 0.7.1 daemon running.
 */
export function beat(version: string = VERSION) {
  try {
    if (!existsSync(HEARTBEAT) || readFileSync(HEARTBEAT, "utf8") !== version) writeFileSync(HEARTBEAT, version, { mode: 0o600 });
    const now = new Date();
    utimesSync(HEARTBEAT, now, now);
  } catch {}
}

/** Version of the daemon writing the heartbeat, or null if there is none or it predates 0.9.1 (empty heartbeat). */
export function heartbeatVersion(): string | null {
  try { return readFileSync(HEARTBEAT, "utf8").trim() || null; } catch { return null; }
}

/** Seconds since the last heartbeat, or null if there never was one. */
export function heartbeatAge(): number | null {
  try { return (Date.now() - statSync(HEARTBEAT).mtimeMs) / 1000; } catch { return null; }
}

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

/** A plist is XML. A path with `&` (a "copies & backups" directory, for one) made it
 *  malformed: launchd rejected it, `launchctl` failed silently and `installLaunchd`
 *  returned "instalado" anyway. The symptom was "nothing arrives", which is exactly what
 *  this file exists to prevent. Measured with `plutil -lint`: "Encountered unknown
 *  ampersand-escape sequence". */
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The PATH recorded in the LaunchAgent.
 *
 * It used to get the whole `process.env.PATH`, that is, the PATH of the shell someone
 * once ran `register` from. That can carry a temporary directory (a worktree's `bin`, a
 * nix shell, a test's `bin`) and the agent uses it on every boot of the machine, forever.
 * A `bun` that shows up there later gets run by the daemon.
 *
 * What stays is the stable part: the system directories and the one of the `bun` in use.
 */
export function agentPath(cmd = daemonCommand(), base = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", claudeDir: string | null = null): string {
  const bunDir = cmd[0]?.startsWith("/") ? dirname(cmd[0]) : null;
  const dirs = base.split(":");
  if (bunDir && !dirs.includes(bunDir)) dirs.unshift(bunDir);
  // And the one of `claude`, which the daemon and the aside window launch by name.
  // Without it, no accepted spoochie can be handled: see `findClaude`.
  if (claudeDir && !dirs.includes(claudeDir)) dirs.unshift(claudeDir);
  return dirs.join(":");
}

/**
 * The directory where `claude` lives, to record it in the agent's PATH.
 *
 * 0.9.9 left the agent's PATH as "system directories plus bun's", and Claude Code's native
 * installer puts `claude` in ~/.local/bin: the aside did not start ("claude: not found" in
 * the window, `Executable not found in $PATH` in the background) and nobody could handle
 * an accepted spoochie. First comes the PATH of whoever runs `register`, which is a
 * Claude Code session and so has it, then the places each installer uses. Only an
 * executable file named `claude` counts.
 */
export function findClaude(dirs: string[] = [
  ...(process.env.PATH ?? "").split(":"),
  join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"), join(homedir(), ".npm-global", "bin"),
  "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun", "bin"),
]): string | null {
  for (const d of dirs) {
    if (!d.startsWith("/")) continue;
    try {
      const f = join(d, "claude");
      if (!statSync(f).isFile()) continue;
      accessSync(f, constants.X_OK);
      return d;
    } catch {}
  }
  return null;
}

/** The PATH recorded in the installed LaunchAgent, or null if there is none (another OS,
 *  or the daemon starts from a hook). It is the PATH the real daemon runs with. */
export function installedAgentPath(): string | null {
  try {
    const m = readFileSync(plistPath(), "utf8").match(/<key>PATH<\/key><string>([^<]*)<\/string>/);
    return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
  } catch { return null; }
}

export function wantedPlist(): string {
  const cmd = daemonCommand();
  const args = cmd.map(a => `      <string>${xml(a)}</string>`).join("\n");
  const path = xml(agentPath(cmd, undefined, findClaude()));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by spoochie (register / join). Rewritten only when the plugin path changes. -->
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${path}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(DAEMON_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(DAEMON_LOG)}</string>
</dict></plist>
`;
}

const uid = () => { try { return execFileSync("id", ["-u"], { encoding: "utf8" }).trim(); } catch { return "501"; } };
const launchctl = (args: string[]) => { try { execFileSync("launchctl", args, { stdio: "ignore" }); return true; } catch { return false; } };

export function launchdInstalled(): boolean {
  return process.platform === "darwin" && existsSync(plistPath()) && !process.env.SPOOCHIE_HOME;
}

/** The plugin version found in a cache path (.../spoochie/0.5.1/...). */
export function versionFromPath(text: string): string | null {
  return /\/spoochie\/(\d+\.\d+\.\d+)\//.exec(text)?.[1] ?? null;
}
export function isNewer(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The LaunchAgent from when this was called spochie: if it is still there, an old
 *  daemon runs that reads the same Slack and would deliver everything twice. It gets
 *  stopped and deleted. */
export function retireOldLaunchd(): boolean {
  const old = join(homedir(), "Library", "LaunchAgents", "dev.spochie.spochied.plist");
  if (!existsSync(old)) return false;
  launchctl(["bootout", `gui/${uid()}/dev.spochie.spochied`]);
  try { unlinkSync(old); } catch {}
  return true;
}

/** The pid in the lock file, if that process is still alive. */
export function pidAlive(): number | null {
  try { const pid = Number(readFileSync(DAEMON_LOCK, "utf8").trim()); if (pid) { process.kill(pid, 0); return pid; } } catch {}
  return null;
}

/**
 * Stops the daemon holding the lock and waits for it to let go (up to 3 s; then
 * SIGKILL). Needed because a daemon started by a hook runs loose: launchd does not know
 * it, `bootout` does not touch it, and the one launchd starts dies at once with "already
 * running" and retries every 10 s forever. Seen live: after updating to 0.9.2, the
 * previous day's 0.7.1 kept beating for a whole day with the plist already new.
 */
export function stopDaemon(): boolean {
  const pid = pidAlive();
  if (!pid) return false;
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  const until = Date.now() + 3000;
  while (Date.now() < until) { try { process.kill(pid, 0); execFileSync("sleep", ["0.1"]); } catch { return true; } }
  try { process.kill(pid, "SIGKILL"); } catch {}
  return true;
}

/** The daemon writing the heartbeat is older than this plugin (or so old it reports no version). */
export function daemonBehind(): boolean {
  if (!pidAlive()) return false;
  const running = heartbeatVersion();
  return running === null || isNewer(VERSION, running);
}

/** Puts the daemon under launchd. Idempotent: if the plist already says the same, it
 *  touches nothing. If it changed (the plugin updated and the path is different), it
 *  reloads it. With SPOOCHIE_HOME set nothing is installed: that is a lab, not your
 *  machine. The return values stay Spanish; callers compare against them. */
export function installLaunchd(): "instalado" | "actualizado" | "igual" | "no" {
  if (process.platform !== "darwin" || process.env.SPOOCHIE_HOME) return "no";
  ensureDirs();
  if (retireOldLaunchd()) console.error("spoochie: stopped and retired the old daemon (spochie)");
  const wanted = wantedPlist();
  const p = plistPath();
  const current = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (current === wanted) {
    // The plist is already this one, but the beating process may be the pre-update one.
    if (!daemonBehind()) return "igual";
    stopDaemon();
    launchctl(["kickstart", `gui/${uid()}/${LABEL}`]);
    return "actualizado";
  }
  // A session with the old plugin does not downgrade the daemon: seen live, a 0.5.1
  // hook put launchd back on 0.5.1 80 s after it had been upgraded, in the middle of a
  // test. It is only replaced by an equal or newer version.
  const theirs = current ? versionFromPath(current) : null, mine = versionFromPath(wanted);
  if (theirs && mine && isNewer(theirs, mine)) return "no";
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, wanted, { mode: 0o644 });
  // The previous one gets stopped, whether it came from launchd (bootout) or from a hook
  // (loose, holding the lock): otherwise the new one dies at once and launchd retries forever.
  if (current !== null) launchctl(["bootout", `gui/${uid()}/${LABEL}`]);
  stopDaemon();
  // If launchd does not take it, say so. It used to return "instalado" no matter what:
  // the `||` swallowed both failures and whoever ran it read that it was in place while
  // the daemon did not start on any reboot.
  if (!launchctl(["bootstrap", `gui/${uid()}`, p]) && !launchctl(["load", "-w", p])) {
    console.error(`spoochie: launchd did not accept ${p}. The daemon still starts from the hook, but it does not survive a reboot. Try: launchctl bootstrap gui/${uid()} ${p}`);
    return "no";
  }
  return current === null ? "instalado" : "actualizado";
}

/** Starts the daemon the right way: through launchd if it is there, by hand if not. */
export function startDaemon() {
  ensureDirs();
  if (launchdInstalled()) {
    if (launchctl(["kickstart", `gui/${uid()}/${LABEL}`])) return;
  }
  const out = openSync(DAEMON_LOG, "a");
  const [cmd, ...args] = daemonCommand();
  // Without the starter's environment: the CLI runs inside a Claude Code session, and
  // its inbox (CLAUDE_CODE_MESSAGING_*) has no business reaching the daemon.
  spawn(cmd, args, { detached: true, stdio: ["ignore", out, out], env: cleanEnv() }).unref();
}
