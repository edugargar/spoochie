#!/usr/bin/env bun
/**
 * The real test: two people, two real Claudes, a conversation that has to arrive.
 *
 * On 01-10 a spoochie was opened between two people with the suite green and everything failed:
 * the accept click reached the daemon empty, and the daemon couldn't find `claude`. The tests
 * didn't see it because they use fake inboxes, relays in a directory, a fake claude on the PATH
 * and a click inside the script. None of that here:
 *
 *   - two empty SPOOCHIE_HOMEs, Ana and Bea, each with its daemon started with the exact
 *     environment launchd would give it (the plist's PATH and HOME, nothing else);
 *   - Ana runs with Bun on the source; Bea with the compiled binary, like someone without
 *     Bun, and her launchd PATH doesn't include bun's directory;
 *   - real public Nostr relays;
 *   - joining via `/spoochie:join` inside a real Claude in a Terminal window;
 *   - Ana asks her Claude in plain language to ask Bea something;
 *   - the notice shows up on screen and the accept button is clicked with the mouse (CGEvent);
 *   - Bea's aside Claude reads her repo and answers;
 *   - the answer has to reach Ana's Claude as a turn, and Ana writes it to disk.
 *
 * The question is a random number that only exists in Bea's repo: if it reaches Ana, the
 * whole conversation happened. Three screenshots: the notice, the answer, the end.
 *
 * If everything passes, it leaves the seal in .git/spoochie-real-test/<sha>. The pre-push
 * hook won't push a commit without its seal. A dirty tree gets no seal: what was tested
 * wouldn't be what gets pushed.
 *
 *   bun scripts/real-test.ts             the whole test (about 5 minutes, uses the screen)
 *   bun scripts/real-test.ts --keep      closes nothing at the end, so you can look
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LAB = mkdtempSync("/tmp/sp-real-");
const HOME_A = join(LAB, "home-ana"), HOME_B = join(LAB, "home-bea");
const REPO_A = join(LAB, "repo-ana"), REPO_B = join(LAB, "repo-bea");
const RECEIVED = join(LAB, "ana-received.txt");
const NUMBER = String(1000 + Math.floor(Math.random() * 9000));
const KEEP = process.argv.includes("--keep");
const CLAUDE = Bun.which("claude");
const SWIFT = join(ROOT, "scripts", "real-test", "window.swift");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s`;
const report: string[] = [];
function step(ok: boolean, what: string, detail = "") {
  const l = `${ok ? "  ok " : "FAIL "}  ${secs()}  ${what}${detail ? `  (${detail})` : ""}`;
  console.log(l); report.push(l);
  appendFileSync(join(LAB, "report.txt"), l + "\n");
}
const pids: number[] = [];
const windows: string[] = [];
const shots: string[] = [];
const threadIds: string[] = [];

function git(...a: string[]) { return spawnSync("git", a, { cwd: ROOT, encoding: "utf8" }).stdout.trim(); }
const json = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
async function until<T>(what: () => T | null | undefined | false, ms: number, every = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = what(); if (v) return v; await sleep(every); }
  return null;
}
const threads = (home: string): any[] => {
  const d = join(home, "threads");
  return existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".json")).map(f => json(join(d, f))).filter(Boolean) : [];
};
const log = (home: string) => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };

/**
 * Screenshots of the test's windows and nothing else. The whole screen takes the
 * Slack, the mail and whatever the person running it has open (measured on the first run):
 * here the notice is cropped by its rectangle and each Terminal by its window id.
 */
function screenshot(name: string, what: { notice?: number[]; terminals?: string[] }) {
  const n = String(shots.length + 1).padStart(2, "0");
  const take = (suffix: string, args: string[]) => {
    const p = join(LAB, `${n}-${name}-${suffix}.png`);
    spawnSync("screencapture", ["-x", "-o", ...args, p]);
    if (existsSync(p)) shots.push(p);
  };
  if (what.notice) take("notice", ["-R", what.notice.join(",")]);
  for (const t of what.terminals ?? []) {
    const id = spawnSync("swift", [SWIFT, "terminal", t], { encoding: "utf8" }).stdout.trim();
    if (id) take(t, ["-l", id]);
  }
}

/** The notices on screen before starting don't belong to this test. */
const notices = () => spawnSync("pgrep", ["-f", "ObjC.import\\('Cocoa'\\)"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
const earlierNotices = new Set(notices());

/** What the daemon runs and the environment launchd gives it, taken from the plist that
 *  `register` would install on that machine. Not one extra directory from this shell's PATH.
 *  With `binary`, the daemon is that compiled executable, as for someone without Bun. */
function launchdEnv(home: string, binary?: string): { cmd: string[]; env: Record<string, string> } {
  const mod = JSON.stringify(join(ROOT, "src", "startup.ts"));
  const code = binary
    ? `const a = await import(${mod}); console.log(JSON.stringify({ cmd: [${JSON.stringify(binary)}, "daemon"], PATH: a.agentPath([${JSON.stringify(binary)}], undefined, a.findClaude()) }))`
    : `const a = await import(${mod}); const p = a.wantedPlist(); console.log(JSON.stringify({ cmd: [...p.match(/<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/)[1].matchAll(/<string>([^<]*)<\\/string>/g)].map(m => m[1]), PATH: p.match(/<key>PATH<\\/key><string>([^<]*)</)[1] }))`;
  const r = spawnSync("bun", ["-e", code], { encoding: "utf8", env: { ...process.env, SPOOCHIE_HOME: home } });
  let d: { cmd: string[]; PATH: string };
  try { d = JSON.parse(r.stdout); } catch { throw new Error(`couldn't get the daemon out of the plist: ${r.stdout}${r.stderr}`); }
  return { cmd: d.cmd, env: { PATH: d.PATH, HOME: process.env.HOME!, SPOOCHIE_HOME: home } };
}

function startDaemon(home: string, binary?: string) {
  const { cmd, env } = launchdEnv(home, binary);
  const d = spawn(cmd[0], cmd.slice(1), { env, stdio: ["ignore", "ignore", "ignore"], detached: true });
  d.unref();
  if (d.pid) pids.push(d.pid);
  return env.PATH;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A Terminal window with a real Claude, the way a person opens it. Without
 *  crossSessionInbound: a person doesn't set it, and if it were needed, that's a bug. */
function claudeWindow(name: string, home: string, repo: string, prompt: string) {
  const script = join(LAB, `${name}.command`);
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '\\033]0;sp-real ${name}\\007'`,
    `export SPOOCHIE_HOME=${sq(home)}`,
    `cd ${sq(repo)} || exit 1`,
    `echo $$ > ${sq(join(LAB, `${name}.pid`))}`,
    `tty > ${sq(join(LAB, `${name}.tty`))}`,
    `exec ${sq(CLAUDE!)} --plugin-dir ${sq(ROOT)} --dangerously-skip-permissions --name sp-real-${name} ${sq(prompt)}`,
    "",
  ].join("\n"));
  chmodSync(script, 0o700);
  // -g: without coming to the front. Opening in front stole the keyboard from whoever was
  // typing, and one of their "p"s landed in the window's command (run aa87215).
  spawnSync("open", ["-g", "-a", "Terminal", script]);
  windows.push(name);
  void answerTrust(name);
}

/** What shows in that window's Terminal tab, found by its tty. */
function tab(name: string, action: "read" | "type", text = ""): string {
  let tty = "";
  try { tty = readFileSync(join(LAB, `${name}.tty`), "utf8").trim(); } catch { return ""; }
  const doIt = action === "read" ? "return history of tb" : `do script ((ASCII character 27) & "${text}") in tb\nreturn ""`;
  // `t` is a loop reference: "contents of t" returns the tab, not its text.
  // Dereference first; reading with "contents of t" never saw the dialog.
  const r = spawnSync("osascript", ["-e", `tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
set tb to contents of t
if tty of tb is "${tty}" then
${doIt}
end if
end repeat
end repeat
end tell`], { encoding: "utf8" });
  return r.stdout;
}

/**
 * Claude Code asks whether you trust a directory the first time you enter it. A person
 * answers once in their repo; here the repos are new on every run. It is answered by
 * typing into the tab (down arrow + Return), without asking for Accessibility permission.
 */
async function answerTrust(name: string) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (tab(name, "read").includes("trust this folder")) { tab(name, "type", "[B"); return; }
    await sleep(1000);
  }
}

function repo(dir: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
  spawnSync("sh", ["-c", "git init -q && git add -A && git -c user.email=lab@sp -c user.name=lab commit -qm init"], { cwd: dir });
}

function cleanUp() {
  if (KEEP) { console.log(`\n--keep: everything is still alive in ${LAB}`); return; }
  for (const n of windows) { const p = json(join(LAB, `${n}.pid`)); if (p) try { process.kill(p) } catch {} }
  for (const h of [HOME_A, HOME_B]) {
    const lock = join(h, "daemon.pid");
    if (existsSync(lock)) try { process.kill(Number(readFileSync(lock, "utf8").trim())) } catch {}
  }
  for (const p of pids) try { process.kill(p) } catch {}
  // The notice is an osascript child of the daemon and outlives it: without this it stays on screen.
  for (const p of notices()) if (!earlierNotices.has(p)) try { process.kill(p) } catch {}
  // Bea's aside Claude is launched with --name spoochie-<id>.
  // With "--": without it, pkill took the pattern for an option and the aside stayed alive.
  for (const id of threadIds) spawnSync("pkill", ["-f", "--", `--name spoochie-${id}`]);
  // And the test's Terminal windows: Ana's, Bea's and each spoochie's aside.
  // Closing them right after killing their processes, they were still "busy" and stayed:
  // nine runs left the screen full of "[Process completed]". Wait for the
  // processes to finish, and count the ones left.
  spawnSync("sleep", ["3"]);
  const r = spawnSync("osascript", ["-e", `tell application "Terminal"
set n to 0
repeat with i from (count windows) to 1 by -1
try
set tb to selected tab of window i
set h to history of tb
if (h contains "${LAB}") and not (busy of tb) then
close window i
set n to n + 1
end if
end try
end repeat
return n
end tell`], { encoding: "utf8" });
  console.log(`test Terminal windows closed: ${r.stdout.trim() || 0}`);
}

async function main() {
  if (process.platform !== "darwin") { console.error("the real test uses a Mac's screen"); process.exit(2); }
  if (!CLAUDE) { console.error("no claude on the PATH"); process.exit(2); }
  // Without Accessibility permission macOS silently drops the synthetic click. Then
  // a person clicks, which is as real as it gets, and the report says who clicked.
  const manualClick = spawnSync("swift", [SWIFT, "permission"], { encoding: "utf8" }).stdout.trim() !== "yes";
  if (manualClick) console.log("No Accessibility permission: when the notice shows up, click 'Let it in' yourself.\n");
  const sha = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  console.log(`real test on ${sha.slice(0, 7)}${dirty ? " (dirty tree: there will be no seal)" : ""}, lab in ${LAB}\n`);

  // 1. Two repos. The answer is only in Bea's.
  repo(REPO_A, { "src/client.ts": "import { MAX_RETRIES } from './config';\nexport const retry = (n: number) => n < MAX_RETRIES;\n" });
  repo(REPO_B, { "src/config.ts": `// How many times a call is retried before giving up.\nexport const MAX_RETRIES = ${NUMBER};\n` });
  mkdirSync(HOME_A, { recursive: true, mode: 0o700 }); mkdirSync(HOME_B, { recursive: true, mode: 0o700 });
  writeFileSync(join(HOME_A, "config.json"), JSON.stringify({ human: "Ana" }), { mode: 0o600 });

  // 2. Bea has no Bun: she uses the compiled binary, as the release hook downloads it.
  //    It is compiled from this tree, with the same command as the release workflow.
  const version = json(join(ROOT, ".claude-plugin", "plugin.json")).version;
  const binB = join(HOME_B, "bin", `spoochie-${version}`);
  mkdirSync(join(HOME_B, "bin"), { recursive: true, mode: 0o700 });
  const comp = spawnSync("bun", ["build", "--compile", join(ROOT, "src", "cli.ts"), "--outfile", binB], { encoding: "utf8" });
  step(comp.status === 0 && existsSync(binB), "Bea's binary compiles", comp.status === 0 ? `spoochie-${version}` : comp.stderr.trim().slice(-300));
  if (!existsSync(binB)) throw new Error("no binary");

  // 3. The daemons, with launchd's environment. Before the sessions: the hook finds them alive.
  const pathA = startDaemon(HOME_A), pathB = startDaemon(HOME_B, binB);
  const alive = await until(() => existsSync(join(HOME_A, "daemon.sock")) && existsSync(join(HOME_B, "daemon.sock")), 20_000, 300);
  step(Boolean(alive), "both daemons start with the plist's PATH", `Ana ${pathA} · Bea ${pathB}`);
  if (!alive) throw new Error("no daemons");

  // 3. Ana invites Bea, without Slack: the line you send by hand.
  const inv = spawnSync(join(ROOT, "bin", "spoochie"), ["invite", "--name", "Bea"], { encoding: "utf8", env: { ...process.env, SPOOCHIE_HOME: HOME_A } });
  const blob = inv.stdout.match(/eyJ[A-Za-z0-9_\-=+/]+/)?.[0];
  step(Boolean(blob), "Ana gets an invite", inv.status === 0 ? "" : inv.stderr.trim());
  if (!blob) throw new Error("no invite");

  // 4. Bea opens Claude and pastes the invite, as the README says.
  claudeWindow("bea", HOME_B, REPO_B, `/spoochie:join ${blob}`);
  const contact = await until(() => Object.values(json(join(HOME_A, "config.json"))?.contacts ?? {}).find((c: any) => c.name === "Bea" && c.npub), 180_000, 2000) as any;
  step(Boolean(contact), "Bea's key reaches Ana through the relays", contact ? `npub ${contact.npub.slice(0, 12)}...` : "Ana doesn't have Bea with an npub");
  const sessionB = await until(() => existsSync(join(HOME_B, "sessions")) && readdirSync(join(HOME_B, "sessions")).length > 0, 60_000);
  step(Boolean(sessionB), "Bea's session gets registered");
  if (!contact) throw new Error("no join");

  // 5. Ana asks her Claude, in plain language, to ask Bea.
  claudeWindow("ana", HOME_A, REPO_A,
    `Use spoochie to ask @bea what value MAX_RETRIES has in src/config.ts in her repo; ` +
    `I only use the constant in src/client.ts and can't see her code. When she answers, write just that number ` +
    `to ${RECEIVED} and close the spoochie.`);
  const opened = await until(() => threads(HOME_A)[0], 240_000, 2000);
  step(Boolean(opened), "Ana's Claude opens the spoochie", opened ? `thread ${opened.id}, ${opened.transporte ?? "?"}` : "");
  if (!opened) throw new Error("Ana didn't open");
  threadIds.push(opened.id);
  const arrived = await until(() => threads(HOME_B).find(t => t.id === opened.id), 120_000, 1000);
  step(Boolean(arrived), "the envelope reaches Bea's daemon");
  if (!arrived) throw new Error("didn't arrive");

  // 6. The notice on screen, and the click on the accept button (the right one). A quick
  //    person clicks before the search (every 1.5 s) sees the window: on run
  //    39dcb60 the daemon logged the accept 1.8 s after drawing it and the test failed
  //    saying there was no notice. The daemon log is the proof it showed up.
  const answered = () => log(HOME_B).match(new RegExp(`notice ${opened.id} dialog: (\\S+)`))?.[1] ?? null;
  const notice = await until(() => {
    if (answered()) return "done";
    const r = spawnSync("swift", [SWIFT, "find"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim().split(" ").map(Number) : null;
  }, 60_000, 500);
  const rect = Array.isArray(notice) ? notice : undefined;
  screenshot("notice", { notice: rect, terminals: ["sp-real-ana"] });
  step(Boolean(notice), "the notice shows up on Bea's screen", rect ? `at ${rect.join(",")}` : notice === "done" ? `clicked before the screenshot: ${answered()}` : "no osascript window 440 wide");
  if (!notice) throw new Error("no notice");
  if (rect && !answered()) {
    const [x, y, w, h] = rect;
    if (manualClick) {
      spawnSync("osascript", ["-e", `display notification "Click Let it in on the spoochie notice" with title "real test"`]);
      process.stdout.write("\x07>>> Click 'Let it in' on the spoochie notice (you have 3 minutes)\n");
    } else {
      // Buttons: 28 tall, bottom edge at MARGIN-8 = 18 from the foot, the accept one flush with the right margin (26).
      spawnSync("swift", [SWIFT, "click", String(x + w - 26 - 40), String(y + h - 18 - 14)]);
    }
  }
  const accepted = await until(() => {
    const t = threads(HOME_B).find(t => t.id === opened.id);
    return t && t.state !== "pending" ? t : null;
  }, manualClick ? 180_000 : 30_000, 500);
  step(Boolean(accepted) && answered() === "accept", `the ${manualClick ? "person's" : "synthetic mouse"} click reaches the daemon as an accept`, accepted ? `state ${accepted.state}, the daemon read ${answered()}` : (log(HOME_B).match(/.*no answer.*|.*button returned.*/g)?.slice(-1)[0] ?? "still pending"));
  if (!accepted) throw new Error("click lost");

  // 7. Bea's aside Claude window starts (this is where "claude: not found" failed).
  const aside = await until(() => readdirSync(join(HOME_B, "sessions")).map(f => json(join(HOME_B, "sessions", f)))
    .find(s => s?.aparte === opened.id && s.socket && !s.socket.startsWith("(")), 90_000, 1000);
  step(Boolean(aside), "Bea's aside Claude starts and registers", aside ? `pid ${aside.pid}` : (log(HOME_B).match(/.*aside.*/g)?.slice(-1)[0] ?? ""));

  // 8. Bea answers and the answer reaches Ana's session: Ana writes the number.
  const received = await until(() => existsSync(RECEIVED) && readFileSync(RECEIVED, "utf8").trim(), 300_000, 2000);
  screenshot("answer", { terminals: ["sp-real-ana", `spoochie-${opened.id}`] });
  step(received === NUMBER, "Bea's answer reaches Ana's Claude", `expected ${NUMBER}, Ana wrote ${received || "nothing"}`);
  // And she uses it soon after it lands in her inbox. On run fa7c225 the daemon delivered it in
  // 8 s and Ana's Claude took 4 min 28 s to see it: it was in a `show` loop in the
  // foreground and the turn couldn't get in. That's a failure even if it arrives in the end.
  const landed = log(HOME_A).match(new RegExp(`^(\\S+) in ${opened.id} claude in the session`, "m"))?.[1];
  const used = existsSync(RECEIVED) ? statSync(RECEIVED).mtimeMs : 0;
  const took = landed && used ? Math.round((used - Date.parse(landed)) / 1000) : null;
  step(took !== null && took <= 90, "Ana's Claude uses it as soon as it lands", took === null ? "can't measure: the inbound line or the file is missing" : `${took} s from the inbox`);

  // 9. The close reaches both sides.
  const closed = await until(() => {
    const a = threads(HOME_A).find(t => t.id === opened.id), b = threads(HOME_B).find(t => t.id === opened.id);
    return (!a || a.state === "closed") && (!b || b.state === "closed");
  }, 120_000, 2000);
  screenshot("end", { terminals: ["sp-real-ana", "sp-real-bea"] });
  step(Boolean(closed), "the spoochie ends up closed on both sides");

  const fails = report.filter(l => l.startsWith("FAIL")).length;
  console.log(`\n${fails ? `${fails} failures` : "Real conversation complete"}. Screenshots:\n${shots.map(c => "  " + c).join("\n")}`);
  if (fails) return 1;
  if (dirty) { console.log("\nDirty tree: no seal left. Commit and run again."); return 1; }
  const dir = join(ROOT, git("rev-parse", "--git-common-dir"), "spoochie-real-test");
  mkdirSync(dir, { recursive: true });
  // The seal is per tree, not per commit: GitHub rewrites commits when merging with
  // rebase, and the release tag lands on a commit with another SHA and the same files.
  // What was tested is the files.
  const tree = git("rev-parse", `${sha}^{tree}`);
  writeFileSync(join(dir, tree), [`${new Date().toISOString()} commit ${sha} tree ${tree}`, ...report, ...shots].join("\n") + "\n");
  console.log(`\nSeal: ${join(dir, tree)} (tree of ${sha.slice(0, 7)})`);
  return 0;
}

let code = 1;
try { code = await main(); }
catch (e: any) {
  step(false, "the test stops", e.message);
  screenshot("where-it-stopped", { terminals: ["sp-real-ana", "sp-real-bea", ...threadIds.map(i => `spoochie-${i}`)] });
  console.log(`\nScreenshots:\n${shots.map(c => "  " + c).join("\n")}\nLogs: ${HOME_A}/daemon.log, ${HOME_B}/daemon.log`);
}
finally { cleanUp(); }
process.exit(code);
