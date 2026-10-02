import { expect, test } from "bun:test";
import { scan, judgeBash, gatekeeper } from "../src/gatekeeper.ts";
import { asideSettings, asideFlags, permissionMode, windowScript, ASIDE_MODEL, asideBudget, ASIDE_BUDGET, firstTurn } from "../src/aside.ts";

const CLI = "/usr/local/bin/spoochie";
const CLI_DEV = "/opt/bun run /repo/src/cli.ts";

const passes = (cmd: string, cli = CLI) => judgeBash(cmd, cli).ok;
const why = (cmd: string, cli = CLI) => { const v = judgeBash(cmd, cli); return v.ok ? "" : v.reason; };

test("the scanner respects quotes: a `;` inside a message is not a metacharacter", () => {
  expect(scan(`spoochie say v1 "fix the modal; then the button"`).problem).toBeUndefined();
  expect(scan(`spoochie say v1 "fix the modal; then the button"`).words).toEqual([
    "spoochie", "say", "v1", "fix the modal; then the button",
  ]);
  expect(scan("git log; touch /tmp/x").problem).toContain('";"');
  expect(scan(`git log 'a b'`).words).toEqual(["git", "log", "a b"]);
  expect(scan(`git log "unclosed`).problem).toContain("unclosed");
});

test("what the shell expands even inside double quotes does not pass", () => {
  expect(scan(`spoochie say v1 "$(cat /etc/passwd)"`).problem).toContain("$(...)");
  expect(scan('spoochie say v1 "`id`"').problem).toContain("backtick");
  // Inside single quotes the shell expands nothing, and the text is just text.
  expect(scan(`spoochie say v1 '$(cat /etc/passwd)'`).problem).toBeUndefined();
});

test("the ways of writing that the allowlist let through", () => {
  // The five from the probe: `Bash(git diff:*)` matches by prefix and ignores the arguments.
  expect(passes("git diff --output=/tmp/written.txt")).toBe(false);
  expect(why("git diff --output=/tmp/written.txt")).toContain("writes the output");
  expect(passes("git diff -o /tmp/written.txt")).toBe(false);
  expect(passes("git format-patch -o /tmp")).toBe(false);
  expect(passes("git log; touch /tmp/written.txt")).toBe(false);
  expect(passes("git status && rm -rf /tmp/x")).toBe(false);
  expect(passes("git log --ext-diff")).toBe(false);
  expect(passes("git log | tee /tmp/written.txt")).toBe(false);
  expect(passes("git log > /tmp/written.txt")).toBe(false);
});

test("nor the ways of reading outside the repo", () => {
  expect(passes("git diff --no-index /etc/passwd /etc/hosts")).toBe(false);
  expect(why("git diff --no-index /etc/passwd /etc/hosts")).toContain("outside the repo");
  expect(passes("git -C /otro/repo log")).toBe(false);
  expect(why("git -C /otro/repo log")).toContain("takes git out of the aside's directory");
  expect(passes("git --git-dir=/otro/.git log")).toBe(false);
  expect(passes("git --work-tree=/otro log")).toBe(false);
});

test("git config runs programs, so -c does not get in", () => {
  expect(passes("git -c core.pager=id log")).toBe(false);
  expect(why("git -c core.pager=id log")).toContain("config");
  expect(passes("git -c alias.x=!id x")).toBe(false);
  expect(passes("git --exec-path=/tmp log")).toBe(false);
});

test("git branch only lists", () => {
  expect(passes("git branch --list")).toBe(true);
  expect(passes("git branch --list -a")).toBe(true);
  expect(passes("git branch")).toBe(false);
  expect(passes("git branch -D main")).toBe(false);
  expect(passes("git branch --list -D")).toBe(false);
  expect(why("git branch -D main")).toContain("--list");
});

test("what the aside does need to do still passes", () => {
  expect(passes("git diff HEAD~1")).toBe(true);
  expect(passes("git log --oneline -20")).toBe(true);
  expect(passes("git show HEAD:src/daemon.ts")).toBe(true);
  expect(passes("git status")).toBe(true);
  expect(passes("git grep -n modal -- src")).toBe(true);
  expect(passes("git blame src/cli.ts")).toBe(true);
  expect(passes("git ls-files")).toBe(true);
  expect(passes("git --no-pager log -1")).toBe(true);
  expect(passes(`${CLI} say v1 "it is the container min-width"`)).toBe(true);
  expect(passes(`${CLI} patch v1 --from-git`)).toBe(true);
  expect(passes(`${CLI} close v1 --reason "resolved"`)).toBe(true);
  expect(passes(`${CLI_DEV} say v1 "hi"`, CLI_DEV)).toBe(true);
});

test("with rtk in front, what comes after is judged, not the proxy", () => {
  expect(passes("rtk git log --oneline")).toBe(true);
  expect(passes("rtk git diff --output=/tmp/x")).toBe(false);
  expect(passes(`rtk ${CLI} say v1 "hi"`)).toBe(true);
  expect(passes("rtk")).toBe(false);
});

test("any other program does not get in, even if it looks harmless", () => {
  expect(passes("ls -la")).toBe(false);
  expect(passes("cat src/cli.ts")).toBe(false);
  expect(passes("bun test")).toBe(false);
  expect(passes("curl https://example.com")).toBe(false);
  expect(why("ls -la")).toContain("is not something the aside may run");
});

test("the aside cannot run spoochie subcommands that accept or release", () => {
  expect(passes(`${CLI} accept v1`)).toBe(false);
  expect(passes(`${CLI} release v1`)).toBe(false);
  expect(passes(`${CLI} open other --subject x`)).toBe(false);
  expect(passes(`${CLI} config --guardian off`)).toBe(false);
  expect(passes(`${CLI} invite --to U0`)).toBe(false);
});

test("the hook lets through what is not Bash and denies what it does not understand", () => {
  const r = (e: unknown) => gatekeeper(e, CLI).hookSpecificOutput;
  expect(r({ tool_name: "Read", tool_input: { file_path: "/x" } }).permissionDecision).toBe("allow");
  expect(r({ tool_name: "Bash", tool_input: { command: "git log" } }).permissionDecision).toBe("allow");
  expect(r({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }).permissionDecision).toBe("deny");
  expect(r({ tool_name: "Bash" }).permissionDecision).toBe("deny");
  expect(r(null).permissionDecision).toBe("deny");
  // The reason tells the aside Claude to do the only thing it can do: talk.
  expect(r({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }).permissionDecisionReason).toContain("spoochie say");
});

test("the aside starts with the gatekeeper hooked in, in window and in background", () => {
  const a = asideSettings("/usr/local/bin/spoochie") as any;
  expect(a.crossSessionInbound).toBe("accept");
  // The matcher said plain "Bash", and that left Read, Grep and Glob out of the hook:
  // the test passed it because it checked the string, not what it covers.
  expect(a.hooks.PreToolUse[0].matcher.split("|")).toContain("Bash");
  expect(a.hooks.PreToolUse[0].hooks[0].command).toBe("/usr/local/bin/spoochie gatekeeper");
});

test("window and background start with the same flags", () => {
  // They were written twice and had drifted: the window with permissionMode() and the
  // background with "default" hardcoded. The window script carries the flags quoted by
  // sq(), so the words coming out of asideFlags are compared in both places.
  const b = asideFlags("v1", "/usr/local/bin/spoochie");
  expect(b).toContain("--permission-mode");
  expect(b[b.indexOf("--permission-mode") + 1]).toBe(permissionMode());
  expect(b[b.indexOf("--settings") + 1]).toBe(JSON.stringify(asideSettings("/usr/local/bin/spoochie")));

  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, context: {}, state: "open", messages: [] };
  const script = windowScript(t, "/tmp", "session-1");
  for (const word of asideFlags("v1")) expect(script).toContain(word.split("\n")[0].slice(0, 40));
  expect(script).not.toContain("--permission-mode default\n");
});

test("the aside answers with a pinned model, not whatever the receiver has set", () => {
  // The aside runs on your machine to answer someone else's question: burning your
  // expensive model is a bill you did not decide on.
  const b = asideFlags("v1", "/usr/local/bin/spoochie");
  expect(b[b.indexOf("--model") + 1]).toBe(ASIDE_MODEL);
  expect(ASIDE_MODEL).toBe("claude-sonnet-5");
});

test("the aside with nobody watching has a spending cap; the window does not need one", () => {
  // `--max-budget-usd` only works with --print, that is in background mode. In the window
  // the brake is the person watching it, plus the spoochie's two clocks.
  expect(asideBudget()).toBe(ASIDE_BUDGET);
  expect(asideFlags("v1")).not.toContain("--max-budget-usd");
  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, context: {}, state: "open", messages: [] };
  expect(windowScript(t, "/tmp", "s1")).not.toContain("max-budget-usd");
});

test("the aside starts with the sentinel hooked to Stop", () => {
  const a = asideSettings("/usr/local/bin/spoochie") as any;
  expect(a.hooks.Stop[0].hooks[0].command).toBe("/usr/local/bin/spoochie sentinel");
});

test("the aside does not read outside the repo it handles", () => {
  const r = (tool: string, input: any, cwd = "/repo") => gatekeeper({ tool_name: tool, cwd, tool_input: input }, CLI).hookSpecificOutput;
  expect(r("Read", { file_path: "/repo/src/cli.ts" }).permissionDecision).toBe("allow");
  expect(r("Read", { file_path: "src/cli.ts" }).permissionDecision).toBe("allow");
  // Its tool list has Read, Grep and Glob unrestricted: that reached ~/.ssh.
  expect(r("Read", { file_path: "/Users/x/.ssh/id_rsa" }).permissionDecision).toBe("deny");
  expect(r("Read", { file_path: "../otro-repo/.env" }).permissionDecision).toBe("deny");
  expect(r("Grep", { pattern: "key", path: "/etc" }).permissionDecision).toBe("deny");
  expect(r("Glob", { pattern: "**/*.pem", path: "/Users/x" }).permissionDecision).toBe("deny");
  expect(r("Read", { file_path: "/Users/x/.ssh/id_rsa" }).permissionDecisionReason).toContain("ask for it through the tunnel");
});

test("nor does it send a file from outside through the tunnel with --file", () => {
  // The allowlist approved the whole line: the subcommand is `say`, which is allowed.
  const cwd = "/repo";
  const d = (cmd: string) => gatekeeper({ tool_name: "Bash", cwd, tool_input: { command: cmd } }, CLI).hookSpecificOutput.permissionDecision;
  expect(d(`${CLI} say v1 --file /repo/notes.md`)).toBe("allow");
  expect(d(`${CLI} say v1 --file ~/.ssh/id_rsa`)).toBe("deny");
  expect(d(`${CLI} say v1 --file ../other/.env`)).toBe("deny");
  expect(d(`${CLI} say v1 --files /repo/a.png,/etc/hosts`)).toBe("deny");
  expect(d(`${CLI} patch v1 --diff-file /tmp/x.diff`)).toBe("deny");
  // With no cwd (outside the aside) paths get no opinion: the gatekeeper only rules in its window.
  expect(gatekeeper({ tool_name: "Bash", tool_input: { command: `${CLI} say v1 --file /x` } }, CLI).hookSpecificOutput.permissionDecision).toBe("allow");
});

test("crossSessionInbound can only be accept: the aside's settings are its own", () => {
  // There is no way to narrow it to one sender (the setting takes accept, hold or
  // refuse and nothing else), so the real boundary is the inbox token, which lives in
  // the registry at 0600. What does get checked here is that spoochie writes these
  // settings nowhere permanent: they go on the aside's launch line and die with it.
  expect(asideSettings("/x").crossSessionInbound).toBe("accept");
  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, context: {}, state: "open", messages: [] };
  const script = windowScript(t, "/tmp", "s1");
  expect(script).toContain("crossSessionInbound");
  // Neither the project's nor the user's settings.json: only the process launched here.
  expect(script).not.toContain(".claude/settings.json");
});

test("the aside's first turn carries the rule of not claiming what it has not read", () => {
  // It is spoochie's whole advantage over asking a model: the answer comes from files
  // read on the other person's machine. As soon as the aside starts coordinating instead
  // of reading, this rule is all that holds it up, so it gets its test before any
  // coordination feature, not after.
  const t: any = { id: "v1", subject: "the modal", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "B", name: "b", cwd: "/b", human: "Edu" }, context: {}, state: "open", messages: [] };
  const turn = firstTurn(t, "B", "/usr/local/bin/spoochie", "/repo");
  expect(turn).toContain("if you have not read it, you do not claim it");
  expect(turn).toContain("I can't see that from here");
  expect(turn).toContain("Never answer about this repo from memory");
  // And it says where it reads from, which is what makes the rule checkable.
  expect(turn).toContain("/repo");
});

/**
 * The gatekeeper only worked for Bash.
 *
 * `asideSettings` hooked it with `matcher: "Bash"`, and a PreToolUse matcher is a
 * regular expression against the tool name. So the whole part about keeping Read, Grep
 * and Glob inside the worktree was written, had its tests, and never ran: the hook did
 * not fire for those tools. An aside could read ~/.ssh and tell it through the tunnel,
 * which is exactly what that code prevents.
 *
 * This test compares the two lists. If one grows and the other does not, it fails here.
 */
test("the hook fires for ALL the tools the gatekeeper judges", async () => {
  const { GATEKEEPER_TOOLS, asideSettings } = await import("../src/aside.ts");
  const { FILE_READERS } = await import("../src/gatekeeper.ts");
  const judged = [...FILE_READERS, "Bash", "Artifact"].sort();
  expect([...GATEKEEPER_TOOLS].sort()).toEqual(judged);

  const matcher = (asideSettings("sp").hooks as any).PreToolUse[0].matcher as string;
  const re = new RegExp(`^(${matcher})$`);
  for (const h of judged) expect(re.test(h)).toBe(true);
});

/**
 * Artifact publishes whatever you give it on claude.ai: it is the aside's only tool that
 * takes content off the machine. It is on the allowlist for one concrete thing,
 * publishing the transcript, and the gatekeeper did not look at it, so it could publish
 * any file the aside could read, that is the whole repo with its `.env`.
 */
test("Artifact only publishes THIS spoochie's transcript", async () => {
  const { transcriptPath } = await import("../src/transcript.ts");
  const before = process.env.SPOOCHIE_ASIDE;
  try {
    process.env.SPOOCHIE_ASIDE = "k7f";
    const v = (file_path?: string) => gatekeeper({ tool_name: "Artifact", tool_input: file_path ? { file_path } : {} }, "sp");
    expect(v(transcriptPath("k7f")).hookSpecificOutput.permissionDecision).toBe("allow");
    // Not another file, not another spoochie's transcript, and not with no path at all.
    expect(v("/tmp/stolen/.env").hookSpecificOutput.permissionDecision).toBe("deny");
    expect(v(transcriptPath("other")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(v().hookSpecificOutput.permissionDecision).toBe("deny");
    // And in a Claude that handles no spoochie, Artifact publishes nothing.
    delete process.env.SPOOCHIE_ASIDE;
    expect(v(transcriptPath("k7f")).hookSpecificOutput.permissionDecision).toBe("deny");
  } finally {
    if (before === undefined) delete process.env.SPOOCHIE_ASIDE; else process.env.SPOOCHIE_ASIDE = before;
  }
});
