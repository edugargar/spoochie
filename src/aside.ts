/**
 * The aside Claude.
 *
 * A spoochie that lands in the session where you are working smears your screen with a
 * conversation that is not yours. So the interactive session only gets the invitation,
 * and the conversation goes to a Claude of its own in a NEW terminal WINDOW, opened by
 * the daemon in the right repo, with read-only permissions and the spoochie CLI. You
 * watch it work there and you can type to it. It lives as long as the spoochie does.
 *
 * If there is no way to open a window (Linux without a desktop, tests, or the window
 * does not register in time) the aside runs in the background as `claude -p`, with its
 * log in ~/.claude/spoochie/aparte/<id>.log. Same Claude, same leash, no screen.
 *
 * Read-only for real: no Edit, no Write, no loose Bash. All it can run is read-only git
 * and the spoochie subcommands that neither open nor release anything. In the window,
 * anything else asks the human watching it for permission.
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, openSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, ensureDirs, cleanEnv, envVar } from "./paths.ts";
import * as T from "./threads.ts";
import { register, type SessionRecord } from "./registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// "aparte" is a directory on disk, shared with 0.9.10 installs.
export const ASIDE_DIR = join(ROOT, "aparte");

/** How the aside Claude invokes spoochie: the same executable this daemon runs. */
export function cliCommand(): string {
  if (import.meta.path.includes("$bunfs")) return process.execPath;
  return `${process.execPath} run ${join(HERE, "cli.ts")}`;
}

/** The only things the aside Claude can run without asking.
 *  If the machine has rtk (a proxy that rewrites every command to `rtk <cmd>` with a
 *  hook), the same commands with `rtk` in front too: without them, every git asked. */
export function allowedTools(cli = cliCommand(), withRtk = Boolean(Bun.which("rtk"))): string[] {
  // Plain `git branch` takes -D and -f; only listing is allowed. The allowedTools
  // pattern matches by prefix and ignores the arguments, so this list on its own let
  // `git diff --output=<file>` through, which writes. The one that reads the arguments
  // is the gatekeeper (gatekeeper.ts), hooked in as PreToolUse in `asideSettings`. This
  // list decides WHICH program; the gatekeeper decides HOW.
  const git = ["diff", "log", "show", "status", "branch --list", "blame", "grep", "ls-files"].map(g => `git ${g}`);
  const sp = ["say", "patch", "branch", "show", "list", "close", "transcript"].map(c => `${cli} ${c}`);
  const cmds = [...git, ...sp];
  const bash = [...cmds, ...(withRtk ? cmds.map(c => `rtk ${c}`) : [])].map(c => `Bash(${c}:*)`);
  // Artifact: the aside publishes the transcript of incoming spoochies, which the daemon
  // cannot publish and the interactive session must not see.
  return ["Read", "Grep", "Glob", "Artifact", ...bash];
}

/** What the aside Claude cannot do even if the permission mode allowed it: deny rules
 *  win over any mode. No MultiEdit: Claude Code no longer has it, and the rule showed up
 *  as a warning in the window the person watches ("matches no known tool", Claude Code
 *  2.1.286, real test of 01-10). */
export const FORBIDDEN_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git checkout:*)", "Bash(git reset:*)", "Bash(rm:*)"];

/** The settings the aside Claude starts with.
 *
 *  `crossSessionInbound: accept` is what makes the tunnel hand it the turns. We looked
 *  at whether it could be narrowed to one sender: it CANNOT. The setting only takes
 *  "accept", "hold" or "refuse" (all three are in the Claude Code binary's own
 *  messages), and there is no sender list. "hold" breaks the tunnel: the turns would
 *  sit waiting for an approval nobody will give, in a window that exists precisely so
 *  nobody gets bothered. What authenticates the writer is the inbox itself, which
 *  demands the registry token (0600) and also checks the pid of the connecting process.
 *  The `PreToolUse` hook is the gatekeeper: the allowlist above matches by prefix and
 *  ignores the arguments, so `git diff --output=file` got through. The gatekeeper sees
 *  the whole line before it runs. Both modes (window and background) use these same
 *  settings: an aside that behaves differently depending on where it runs is not a
 *  control. */

/** The tools that go through the gatekeeper.
 *
 *  A PreToolUse hook's `matcher` is a regular expression against the tool name, and
 *  here it said plain "Bash". So the gatekeeper only saw Bash calls: its whole part
 *  about keeping Read, Grep and Glob inside the worktree was written, tested on its own,
 *  and never ran. An aside could read ~/.ssh and tell it through the tunnel, which is
 *  exactly what that code was meant to stop.
 *
 *  A test compares this list with the one `gatekeeper()` judges: if one grows and the
 *  other does not, it fails. */
export const GATEKEEPER_TOOLS = ["Bash", "Read", "Grep", "Glob", "NotebookRead", "Artifact"];
export function asideSettings(cli = cliCommand()): Record<string, unknown> {
  return {
    crossSessionInbound: "accept",
    hooks: {
      PreToolUse: [
        { matcher: GATEKEEPER_TOOLS.join("|"), hooks: [{ type: "command", command: `${cli} gatekeeper` }] },
      ],
      // The sentinel: an aside that ends its turn without answering through the tunnel
      // leaves the other side in silence until the clock closes the spoochie.
      Stop: [
        { hooks: [{ type: "command", command: `${cli} sentinel` }] },
      ],
    },
  };
}

/** The flags the aside Claude starts with, the same in window and background.
 *
 *  We thought about declaring the aside as a plugin agent (a file with its tool list,
 *  reviewable in a diff) instead of as flags. DROPPED after looking at what `--agents`
 *  is: it defines SUBagents the session can dispatch to, not the persona of the main
 *  session. The aside is the main session of its own `claude` process, so moving the
 *  list there would leave unrestricted exactly the one that reads the repo and answers.
 *  The boundary is these flags and the hooks, and that is why they stay here. The good
 *  part of that idea (that nobody can disarm it by editing one string) is covered by
 *  this function and its parity test.
 *
 *  They go on the command line and so show up in `ps`. We thought about moving them to
 *  a settings file at 0700 and DROPPED it: there is no secret inside. The tool list is a
 *  policy, not a credential, and it is published in this repo anyway; all it reveals is
 *  the binary's path, which any process of the same user can already read from disk.
 *  And the real control is not this list but the gatekeeper, which reads the arguments:
 *  hiding the map would be pointless when the map opens no door.
 *
 *  They used to be written twice and had already drifted: the window used
 *  `permissionMode()` and the background had `"default"` hardcoded, so the same message
 *  was judged differently depending on where the aside ran, and the screenless mode was
 *  also the one with nobody to ask. One place decides, and a test compares the two
 *  lists. */
export function asideFlags(id: string, cli = cliCommand()): string[] {
  return [
    "--name", `spoochie-${id}`,
    "--model", asideModel(),
    "--permission-mode", permissionMode(),
    "--allowedTools", allowedTools(cli).join(","),
    "--disallowedTools", FORBIDDEN_TOOLS.join(","),
    "--settings", JSON.stringify(asideSettings(cli)),
  ];
}

/**
 * How much an aside can spend answering one question.
 *
 * `--max-budget-usd` only works with `--print`, that is in background mode, which is
 * the one that runs with nobody watching: on a server without a desktop, or when the
 * window could not be opened. There nothing stopped it from reading the whole repo in a
 * loop while the other side waits. In window mode the brake is a person sitting in
 * front of it, plus the spoochie's two clocks (10 min of silence, 4 h unaccepted), so
 * it is not needed.
 *
 * One dollar is plenty to read a few files and answer. SPOOCHIE_ASIDE_BUDGET changes
 * it; "0" removes it.
 */
export const ASIDE_BUDGET = "1.00";
export function asideBudget(): string | null {
  const v = envVar("SPOOCHIE_ASIDE_BUDGET", "SPOOCHIE_APARTE_PRESUPUESTO") ?? ASIDE_BUDGET;
  return v === "0" || v === "" ? null : v;
}

/**
 * Which model the aside Claude answers with.
 *
 * Pinned, and not whatever the person has set, for a money reason that is not theirs:
 * the aside runs on YOUR machine to answer SOMEONE ELSE's question. If your session is
 * on Opus, a teammate's question burns Opus without you deciding it. Sonnet reads a
 * repo and answers with facts from the files, which is all it does. The watcher was
 * already pinned to Haiku for the same reason (guardian.ts).
 *
 * SPOOCHIE_ASIDE_MODEL changes it, for whoever wants the opposite.
 */
export const ASIDE_MODEL = "claude-sonnet-5";
export function asideModel(): string {
  return envVar("SPOOCHIE_ASIDE_MODEL", "SPOOCHIE_APARTE_MODELO") || ASIDE_MODEL;
}

/** The permission mode the aside starts with, in window and in background. "auto" by
 *  default: what is not on the allowlist gets decided by Claude Code's classifier
 *  instead of stopping to ask; the first real test left the window waiting on an "ls"
 *  while the person was in a meeting. SPOOCHIE_ASIDE_PERMISSIONS=default asks about
 *  everything again. */
export function permissionMode(): string {
  const v = envVar("SPOOCHIE_ASIDE_PERMISSIONS", "SPOOCHIE_APARTE_PERMISOS");
  return v === "default" || v === "auto" ? v : "auto";
}

/** The first turn: who it is, which spoochie it handles, what was said so far, and how to answer. */
export function firstTurn(t: T.Thread, sessionId: string, cli = cliCommand(), cwd = process.cwd(), origin?: string): string {
  const other = T.otherSide(t, sessionId);
  const where = origin
    ? `from ${cwd}, which is a CLEAN COPY of ${origin} at its HEAD (git worktree). Whatever is not committed there (local changes, .env) is not here: if someone asks about it, say so.`
    : `from ${cwd}.`;
  // "si" and "descartado" are values stored in the thread file.
  const history = t.messages.filter(m => m.retenido !== "si" && m.retenido !== "descartado")
    .map(m => T.renderMessage(t, m, sessionId)).join("\n\n");
  return [
    `You are the Claude handling spoochie ${t.id} on behalf of ${T.mySide(t, sessionId).human ?? "your human"}, ${where}`,
    `A spoochie is a tunnel to the Claude session of ${other.human ?? other.name}, another person. The tunnel is ALREADY open: your human accepted it.`,
    `Your job: read this repo and answer what they ask about it, with facts from the files. Nothing else.`,
    `RULE WITH NO EXCEPTIONS: if you have not read it, you do not claim it. Everything you say through the tunnel comes from a file you opened or a read-only git command you ran in THIS directory. What you cannot check here, say like this: "I can't see that from here" or "the person would have to look at that". Never answer about this repo from memory, and never guess from how things are usually named: whoever asks will act on what you tell them, and a guess dressed up as a fact is worse than "I don't know".`,
    `You answer with:  ${cli} say ${t.id} "<text>"   (or --file <path> if it is long). A patch: ${cli} patch ${t.id} --from-git. Close it when it is resolved: ${cli} close ${t.id} --reason "...".`,
    `You cannot write files or run anything other than read-only git and spoochie: if they ask for something else, say so through the tunnel and stop.`,
    `Every new message from the other side reaches you as one more turn. Answer each one through the tunnel, not here. If your human types to you in this window, that one is for you.`,
    ``,
    `Subject: ${t.subject}`,
    ``,
    history,
  ].join("\n");
}

// The values are kept: src/daemon.ts compares against them.
export type Mode = "ventana" | "fondo";
export type Aside = {
  id: string; cwd: string; modo: Mode; sess: SessionRecord;
  /** If `cwd` is a worktree copy, the checkout it comes from. */
  origen?: string;
  /** Background mode only: the `claude -p` whose stdin we own. */
  child?: ChildProcess;
  /** Window mode: what arrived before the window registered. */
  cola: string[];
  /** Window mode: its session's hook already wrote the record with a socket. */
  listo: boolean;
  /** Background mode: the process has died. */
  muerto: boolean;
};

/** An aside's session id. One per launch: if the spoochie moves repo with `take`, the
 *  old window and the new one do not share a record, and closing the old one does not
 *  close the spoochie. The CLI running inside learns it from SPOOCHIE_ASIDE_SESSION.
 *  The `aparte-` prefix is kept: it is on disk in sessions/*.json and the daemon matches it. */
export const asideSession = (id: string) => `aparte-${id}-${Date.now().toString(36)}`;
export const asideName = (id: string) => `aparte-${id}`;
/** The socket of the provisional record the daemon writes in window mode, until the
 *  window's SessionStart hook replaces it with the real one. Kept in Spanish: it is
 *  written to sessions/*.json. */
export const PENDING_SOCKET = "(esperando a la ventana)";

/**
 * How the aside opens.
 *   SPOOCHIE_WINDOW=background   always in the background (tests, servers)
 *   SPOOCHIE_WINDOW=<program>    that program gets the script and runs it wherever it likes (tests)
 *   unset                        window on macOS, background elsewhere
 */
export function asideMode(): Mode {
  const v = envVar("SPOOCHIE_WINDOW", "SPOOCHIE_VENTANA");
  if (v === "background") return "fondo";
  if (v && v !== "window") return "ventana";
  return process.platform === "darwin" ? "ventana" : "fondo";
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The script the new window runs: it enters the repo and starts claude on its leash.
 *  Absolute paths and the daemon's PATH, because a window opened by AppleScript does
 *  not go through the shell profile and `claude` would not be on its PATH. */
export function windowScript(t: T.Thread, cwd: string, sessionId: string): string {
  const claude = Bun.which("claude") ?? "claude";
  // A daemon running from a development checkout (not from the installed or compiled
  // plugin) lends its own plugin to the window, so the hook that registers it is the
  // same version as the daemon waiting for it.
  const dev = !import.meta.path.includes("$bunfs") && !HERE.includes("/plugins/cache/") ? join(HERE, "..") : null;
  return [
    `#!/bin/sh`,
    `# spoochie ${t.id}: ${t.subject.replace(/\n/g, " ")}`,
    `export PATH=${sq(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}`,
    `export SPOOCHIE_ASIDE=${sq(t.id)}`,
    `export SPOOCHIE_ASIDE_SESSION=${sq(sessionId)}`,
    process.env.SPOOCHIE_HOME ? `export SPOOCHIE_HOME=${sq(process.env.SPOOCHIE_HOME)}` : `unset SPOOCHIE_HOME`,
    `cd ${sq(cwd)} || exit 1`,
    `printf '\\033]0;spoochie ${t.id}\\007'`,
    `echo ${sq(`spoochie ${t.id} · ${t.subject}`)}`,
    `echo ${sq(`Aside Claude: read-only + spoochie say. You can type to it here. Closing the window closes the spoochie.`)}`,
    `exec ${sq(claude)} ${asideFlags(t.id).map(sq).join(" ")}${dev ? ` --plugin-dir ${sq(dev)}` : ""}`,
    ``,
  ].join("\n");
}

/** Opens a terminal window that runs the script. Returns how it did it, or null.
 *  On macOS it is Terminal.app via `open`, which asks for no permission. iTerm through
 *  AppleScript was tried: from the launchd daemon it fails on the Automation
 *  permission, and from a shell it hangs waiting on the dialog. A `.command` in Terminal
 *  opened the window in 4 s without asking anything. */
export function openWindow(script: string): string | null {
  const custom = envVar("SPOOCHIE_WINDOW", "SPOOCHIE_VENTANA");
  if (custom && custom !== "window") {
    const p = spawn(custom, [script], { detached: true, stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
    return custom;
  }
  if (process.platform !== "darwin") return null;
  const r = spawnSync("open", ["-a", "Terminal", script], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 ? "Terminal" : null;
}

/**
 * Launches the aside Claude for a spoochie in a directory.
 *
 * In window mode the daemon writes a provisional record (so the spoochie already points
 * at the aside and nothing else falls into the interactive session) and opens the
 * window; that window's SessionStart hook overwrites the record with its socket, and
 * then whatever piled up gets delivered. In background mode the daemon writes the
 * record and delivery goes through stdin, no socket.
 */
export function launch(t: T.Thread, cwd: string, how: Mode = asideMode()): Aside | null {
  ensureDirs();
  mkdirSync(ASIDE_DIR, { recursive: true, mode: 0o700 });
  const base = { sessionId: asideSession(t.id), name: asideName(t.id), cwd, startedAt: Date.now(), aparte: t.id };
  const env = cleanEnv({ SPOOCHIE_ASIDE: t.id, SPOOCHIE_ASIDE_SESSION: base.sessionId });

  if (how === "ventana") {
    const script = join(ASIDE_DIR, `${t.id}.command`);
    writeFileSync(script, windowScript(t, cwd, base.sessionId), { mode: 0o700 });
    chmodSync(script, 0o700);
    const sess: SessionRecord = { ...base, socket: PENDING_SOCKET, token: "", pid: process.pid };
    register(sess);
    const opener = openWindow(script);
    if (!opener) return null;
    return { id: t.id, cwd, modo: "ventana", sess, cola: [], listo: false, muerto: false };
  }

  const out = openSync(join(ASIDE_DIR, `${t.id}.log`), "a");
  const budget = asideBudget();
  const child = spawn("claude", [
    "-p", "--verbose",
    "--input-format", "stream-json", "--output-format", "stream-json",
    // Only here: `--max-budget-usd` does nothing without `--print`, and in the window the
    // brake is the person watching it.
    ...(budget ? ["--max-budget-usd", budget] : []),
    ...asideFlags(t.id),
  ], { cwd, env, stdio: ["pipe", out, out] });
  child.on("error", () => {});
  const sess: SessionRecord = { ...base, socket: "(stdin)", token: "", pid: child.pid ?? 0 };
  register(sess);
  const a: Aside = { id: t.id, cwd, modo: "fondo", sess, child, cola: [], listo: true, muerto: false };
  child.on("exit", () => { a.muerto = true; });
  return a;
}

/** One turn through the background aside's standard input. */
export function stdinTurn(a: Aside, content: string): boolean {
  const c = a.child;
  if (!c || !c.stdin || c.stdin.destroyed || c.exitCode !== null) return false;
  return c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

/** The real record the window's hook leaves, if it is there yet. */
export function windowRecord(a: Aside, live: SessionRecord[]): SessionRecord | undefined {
  return live.find(s => s.aparte === a.id && s.socket !== PENDING_SOCKET && s.socket !== "(stdin)");
}

export function alive(a: Aside): boolean {
  return a.modo === "fondo" ? !a.muerto : true;
}

export function killAside(a: Aside) {
  if (a.child) { try { a.child.kill(); } catch {} }
}

/**
 * A clean copy of the repo for the aside to work in: `git worktree add --detach` of
 * HEAD in ~/.claude/spoochie/aparte/<id>-copia. It shares objects with the checkout
 * (no duplicate .git), takes as long as a checkout, and nothing uncommitted travels.
 * If the directory is not a git repo, null: it is handled in place. The `-copia` suffix
 * stays as it is on disk.
 */
export function worktreeCopy(cwd: string, id: string): string | null {
  try { execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { stdio: "ignore" }); } catch { return null; }
  mkdirSync(ASIDE_DIR, { recursive: true, mode: 0o700 });
  const dest = join(ASIDE_DIR, `${id}-copia`);
  try {
    rmSync(dest, { recursive: true, force: true });
    execFileSync("git", ["-C", cwd, "worktree", "prune"], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "worktree", "add", "--detach", dest, "HEAD"], { stdio: "ignore" });
    return dest;
  } catch { return null; }
}

export function removeCopy(origin: string, copy: string) {
  try { execFileSync("git", ["-C", origin, "worktree", "remove", "--force", copy], { stdio: "ignore" }); }
  catch { rmSync(copy, { recursive: true, force: true }); }
}
