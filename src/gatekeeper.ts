/**
 * The gatekeeper: judges every Bash call of the aside Claude by reading the real arguments.
 *
 * Why it exists. `--allowedTools` matches by prefix and ignores what comes after, so
 * `Bash(git diff:*)` lets `git diff --output=file` through, which writes. The comment on
 * `allowedTools` admitted it as an accepted cost. A `PreToolUse` hook gets the whole
 * line before it runs and can say no, which is the only way to turn that assumption
 * into a control.
 *
 * The rule is an allowlist, in this order: no shell metacharacter outside quotes, a
 * known head (git, the spoochie CLI, or rtk in front of either), a read-only
 * subcommand, and no flag that writes, reads outside the repo or runs another program.
 * Whatever is not understood does not pass.
 *
 * A message's text may carry `;` or `&&`: they sit inside quotes and the scanner
 * respects quotes, because the shell respects them too. What is never allowed, not even
 * inside double quotes, is what the shell expands anyway: `$(...)` and backticks.
 */

import { resolve, relative, isAbsolute } from "node:path";
import { transcriptPath } from "./transcript.ts";
import { envVar } from "./paths.ts";

/** The tools that open a file by its path. `aside.ts` hooks these plus Bash and
 *  Artifact, and a test compares the two lists: a name in one and not the other is code
 *  that gets written and never runs, which is what happened. */
export const FILE_READERS = ["Read", "Grep", "Glob", "NotebookRead"];

export type Verdict = { ok: true } | { ok: false; por: string };

/** Whether a path falls inside the aside's directory. `..` and outside absolutes do not. */
export function inside(base: string, path: string): boolean {
  if (!base) return true;
  // The shell expands the tilde, not us: `resolve("/repo", "~/x")` would give
  // "/repo/~/x", which looks inside and is not. No repo is called "~".
  if (path.startsWith("~")) return false;
  const r = relative(resolve(base), resolve(base, path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** The spoochie CLI flags that open a file from disk and send it through the tunnel.
 *  `spoochie say v1 --file ~/.ssh/id_rsa` was a line the allowlist approved whole: the
 *  subcommand is `say`, which is allowed. */
const SP_FILE_FLAGS = ["--file", "--files", "--diff-file"];

/** Git subcommands that only read. `branch` gets its own check: bare, it takes -D and -f. */
const GIT_READ = new Set(["diff", "log", "show", "status", "blame", "grep", "ls-files", "branch"]);

/** Git flags that write, read outside the repo or run another program. */
const GIT_BAD_FLAGS: Record<string, string> = {
  "-o": "writes the output to a file",
  "--output": "writes the output to a file",
  "--output-directory": "writes the output to a directory",
  "--no-index": "compares files outside the repo",
  "--ext-diff": "runs whatever external diff the config names",
  "--textconv": "runs whatever filter the config names",
  "-O": "opens the files in the pager",
  "--open-files-in-pager": "opens the files in the pager",
};

/** Git global options (the ones before the subcommand) that change where it looks or
 *  that run something. `-C` is the one that takes git out of the aside's worktree. */
const GIT_BAD_GLOBALS: Record<string, string> = {
  "-c": "injects config, and git config runs programs",
  "--config-env": "injects config from the environment",
  "-C": "takes git out of the aside's directory",
  "--git-dir": "points at another repository",
  "--work-tree": "points at another working tree",
  "--exec-path": "changes where git's binaries come from",
  "--upload-pack": "runs whatever program it is given",
  "--receive-pack": "runs whatever program it is given",
  "--namespace": "changes the refs namespace",
};

/** `git branch` only to list: everything else deletes, moves or forces. */
const GIT_BRANCH_FLAGS = new Set(["--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--contains", "--no-contains", "--points-at", "--format", "--sort", "--merged", "--no-merged", "--color", "--no-color", "--column", "--no-column"]);

/** What the aside may ask of its own CLI. */
const SP_SUBCOMMANDS = new Set(["say", "patch", "branch", "show", "list", "close", "transcript"]);

type Scan = { words: string[]; problem?: string };

/**
 * Splits the line into words the way the shell would, and stops as soon as it sees
 * something that chains, redirects or substitutes. Returns the words already unquoted,
 * which is what the program would receive.
 */
export function scan(cmd: string): Scan {
  const words: string[] = [];
  let cur = "", open = false;
  let mode: "free" | "single" | "double" = "free";
  const stop = (problem: string): Scan => ({ words, problem });

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], next = cmd[i + 1];

    if (mode === "single") {
      if (c === "'") { mode = "free"; continue; }
      cur += c; continue;
    }

    if (mode === "double") {
      if (c === '"') { mode = "free"; continue; }
      if (c === "\\" && next !== undefined) { cur += next; i++; continue; }
      if (c === "`") return stop("a backtick inside double quotes");
      if (c === "$" && next === "(") return stop("a $(...) substitution inside double quotes");
      cur += c; continue;
    }

    if (c === "\\") {
      if (next === undefined) return stop("a trailing backslash");
      cur += next; i++; open = true; continue;
    }
    if (c === "'") { mode = "single"; open = true; continue; }
    if (c === '"') { mode = "double"; open = true; continue; }
    if (c === "`") return stop("a backtick");
    if (c === "$" && next === "(") return stop("a $(...) substitution");
    if (c === ";" || c === "&" || c === "|" || c === ">" || c === "<" || c === "\n") return stop(`the metacharacter ${JSON.stringify(c)} outside quotes`);
    if (c === " " || c === "\t") { if (open) { words.push(cur); cur = ""; open = false; } continue; }
    cur += c; open = true;
  }

  if (mode !== "free") return stop("unclosed quotes");
  if (open) words.push(cur);
  return { words };
}

/** A flag's name without its value: `--output=x` is `--output`. */
const flagName = (p: string) => p.startsWith("--") && p.includes("=") ? p.slice(0, p.indexOf("=")) : p;

function judgeGit(rest: string[]): Verdict {
  // Global options before the subcommand.
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    const n = flagName(rest[i]);
    const why = GIT_BAD_GLOBALS[n];
    if (why) return { ok: false, por: `\`git ${n}\` ${why}` };
    // An unknown global before the subcommand is not guessed at.
    if (n !== "--no-pager" && n !== "-P" && n !== "--literal-pathspecs" && n !== "--no-replace-objects") {
      return { ok: false, por: `I don't recognize the global option \`git ${n}\`` };
    }
    i++;
  }

  const sub = rest[i];
  if (!sub) return { ok: false, por: "git without a subcommand" };
  if (!GIT_READ.has(sub)) return { ok: false, por: `\`git ${sub}\` is not one of the read-only subcommands` };

  const args = rest.slice(i + 1);
  for (const a of args) {
    const n = flagName(a);
    const why = GIT_BAD_FLAGS[n];
    if (why) return { ok: false, por: `\`${n}\` ${why}` };
    // -o glued to its value (-o/tmp/x) is not a form git accepts, but -O is.
    if (a.startsWith("-o") && a.length > 2 && !a.startsWith("--")) return { ok: false, por: "`-o` writes the output to a file" };
  }

  if (sub === "branch") {
    const flags = args.filter(a => a.startsWith("-"));
    if (!flags.some(a => flagName(a) === "--list")) return { ok: false, por: "`git branch` only with `--list`: bare, it takes -D and -f" };
    for (const a of flags) {
      if (!GIT_BRANCH_FLAGS.has(flagName(a))) return { ok: false, por: `\`git branch ${flagName(a)}\` does more than list` };
    }
  }

  return { ok: true };
}

function judgeSpoochie(rest: string[], cwd: string): Verdict {
  const sub = rest[0];
  if (!sub) return { ok: false, por: "spoochie without a subcommand" };
  if (!SP_SUBCOMMANDS.has(sub)) return { ok: false, por: `\`spoochie ${sub}\` is not one the aside may run` };

  for (let i = 1; i < rest.length; i++) {
    const n = flagName(rest[i]);
    if (!SP_FILE_FLAGS.includes(n)) continue;
    const value = rest[i].includes("=") ? rest[i].slice(rest[i].indexOf("=") + 1) : rest[i + 1];
    if (!value || value === "-") continue;
    for (const path of value.split(",").map(x => x.trim()).filter(Boolean)) {
      if (!inside(cwd, path)) return { ok: false, por: `\`${n} ${path}\` sends a file from outside this repo through the tunnel` };
    }
  }
  return { ok: true };
}

/**
 * The verdict on one Bash line. `cli` is how the spoochie CLI is invoked on this
 * machine, which may be one word (compiled binary) or three (`bun run cli.ts`).
 */
export function judgeBash(cmd: string, cli: string, cwd = ""): Verdict {
  const { words, problem } = scan(cmd);
  if (problem) return { ok: false, por: `the line has ${problem}` };
  if (!words.length) return { ok: false, por: "an empty line" };

  const cliHead = scan(cli).words;
  let p = words;

  // rtk in front: the proxy rewrites the command, what comes after is what matters.
  if (p[0] === "rtk") p = p.slice(1);
  if (!p.length) return { ok: false, por: "rtk with no command after it" };

  if (cliHead.length && p.length >= cliHead.length && cliHead.every((w, n) => p[n] === w)) {
    return judgeSpoochie(p.slice(cliHead.length), cwd);
  }
  if (p[0] === "git") return judgeGit(p.slice(1));

  return { ok: false, por: `\`${p[0]}\` is not something the aside may run (read-only git and spoochie)` };
}

/** What the hook writes to its standard output. */
export type Decision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
};

const decision = (permissionDecision: "allow" | "deny", permissionDecisionReason: string): Decision =>
  ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } });

/**
 * The whole hook, from Claude Code's input to the verdict. Whatever is not Bash passes
 * without comment: the allowlist and the hard denies take care of that.
 */
export function gatekeeper(input: unknown, cli: string): Decision {
  const e = input as { tool_name?: string; cwd?: string; tool_input?: Record<string, unknown> } | null;
  if (!e || typeof e !== "object") return decision("deny", "spoochie: I don't understand the hook input");
  const cwd = typeof e.cwd === "string" ? e.cwd : "";

  // Reading outside the aside's directory. The aside works on a clean copy of the repo;
  // its tool list has Read, Grep and Glob unrestricted, so it could read ~/.ssh or
  // another project's .env and tell it through the tunnel.
  if (FILE_READERS.includes(e.tool_name ?? "")) {
    for (const field of ["file_path", "path", "notebook_path"]) {
      const v = e.tool_input?.[field];
      if (typeof v === "string" && v && !inside(cwd, v)) {
        return decision("deny", `spoochie: ${v} is outside the repo this spoochie handles. This Claude only reads what is here; if you need something from outside, ask for it through the tunnel and let the person look.`);
      }
    }
    return decision("allow", "");
  }

  // Artifact publishes whatever you give it on claude.ai, so it is the aside's only
  // tool that takes content off this machine. It is on the allowlist for one concrete,
  // narrow reason: the daemon cannot publish an Artifact and the interactive session
  // must not see the spoochie, so the aside publishes the transcript.
  //
  // Without this, that narrow reason was a wide door: `Artifact` with any `file_path`
  // publishes whatever the aside could read, and what it can read is the whole repo,
  // `.env` included. The watcher looks at the incoming message, but the watcher is a
  // model and the corpus scores 23 of 24. This is not a model.
  if (e.tool_name === "Artifact") {
    const mine = transcriptPath(envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE") ?? "");
    const path = e.tool_input?.file_path;
    if (!envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE")) return decision("deny", "spoochie: here Artifact only publishes a spoochie's transcript, and this Claude is not handling one");
    if (typeof path !== "string" || resolve(path) !== resolve(mine)) {
      return decision("deny", `spoochie: Artifact here only publishes this spoochie's transcript (${mine}). Publishing anything else takes something off this machine that nobody agreed to let out.`);
    }
    return decision("allow", "");
  }

  if (e.tool_name !== "Bash") return decision("allow", "");

  const cmd = e.tool_input?.command;
  if (typeof cmd !== "string") return decision("deny", "spoochie: a Bash call with no command");

  const v = judgeBash(cmd, cli, cwd);
  return v.ok
    ? decision("allow", "")
    : decision("deny", `spoochie: this Claude handles a tunnel and only reads. Blocked because ${v.por}. If you need that, say so through the tunnel with \`spoochie say\` and let the person on the other side do it.`);
}
