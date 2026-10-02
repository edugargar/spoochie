import { expect, test } from "bun:test";

test("launchd is never downgraded: an older plugin path does not replace a newer one", async () => {
  const { versionFromPath, isNewer } = await import("../src/startup.ts");
  expect(versionFromPath("<string>/Users/x/.claude/plugins/cache/edugargar/spoochie/0.5.1/src/daemon.ts</string>")).toBe("0.5.1");
  expect(versionFromPath("/Users/x/Desktop/spoochie/src/daemon.ts")).toBeNull();
  expect(isNewer("0.5.2", "0.5.1")).toBe(true);
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("0.5.1", "0.5.1")).toBe(false);
});

test("the state in ~/.claude/spochie moves to spoochie once, and does not overwrite what is there", async () => {
  const { migrateState } = await import("../src/paths.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "sp-mig-"));
  const from = join(base, "spochie"), to = join(base, "spoochie");
  mkdirSync(from); writeFileSync(join(from, "config.json"), '{"human":"Edu"}');
  expect(migrateState(from, to)).toBe(true);
  expect(existsSync(from)).toBe(false);
  expect(readFileSync(join(to, "config.json"), "utf8")).toContain("Edu");
  // Second time: nothing to move. And if there were something new, it is left alone.
  expect(migrateState(from, to)).toBe(false);
  mkdirSync(from); writeFileSync(join(from, "config.json"), "{}");
  expect(migrateState(from, to)).toBe(false);
  expect(readFileSync(join(to, "config.json"), "utf8")).toContain("Edu");
});

test("the heartbeat carries the daemon version, and doctor compares it with the plugin's", async () => {
  const { beat, heartbeatVersion, HEARTBEAT } = await import("../src/startup.ts");
  const { readFileSync } = await import("node:fs");
  beat("0.7.1");
  expect(heartbeatVersion()).toBe("0.7.1");
  beat("0.9.1");
  expect(readFileSync(HEARTBEAT, "utf8")).toBe("0.9.1");
  // A heartbeat from a daemon older than 0.9.1 is empty: doctor cannot know its version.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(HEARTBEAT, "");
  expect(heartbeatVersion()).toBeNull();
});

test("a loose daemon older than the plugin is detected and stopped, waiting for it to release the lock", async () => {
  const { stopDaemon, daemonBehind, pidAlive, beat, HEARTBEAT } = await import("../src/startup.ts");
  const { DAEMON_LOCK } = await import("../src/paths.ts");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, existsSync } = await import("node:fs");
  // A process playing an old daemon: loose (its parent is no longer this test, like one
  // started by a hook), holding the lock, and beating without a version (pre 0.9.1).
  const pid = Number(execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  writeFileSync(DAEMON_LOCK, String(pid));
  writeFileSync(HEARTBEAT, "");
  expect(pidAlive()).toBe(pid);
  expect(daemonBehind()).toBe(true);
  // With this plugin's version in the heartbeat, it is not behind.
  beat();
  expect(daemonBehind()).toBe(false);
  beat("0.7.1");
  expect(daemonBehind()).toBe(true);
  const t0 = Date.now();
  expect(stopDaemon()).toBe(true);
  expect(Date.now() - t0).toBeLessThan(3000);
  await new Promise(r => setTimeout(r, 100));
  expect(pidAlive()).toBeNull();
  // With nobody holding the lock, there is nothing to stop.
  expect(stopDaemon()).toBe(false);
  expect(existsSync(DAEMON_LOCK)).toBe(true);
});

/**
 * The plist is XML, and launchd rejects a malformed plist without anyone noticing.
 *
 * Paths went in as they were. A directory with `&` (one called "copias & backups", for
 * one) made the file invalid: measured with `plutil -lint`, "Encountered unknown
 * ampersand-escape sequence". launchd did not load it, `launchctl` failed silently
 * because the `||` swallowed both attempts, and `installLaunchd` returned "instalado"
 * anyway. The symptom was "nothing arrives", which is exactly what this file exists to
 * prevent.
 */
test.if(process.platform === "darwin")("the plist stays valid XML with odd paths", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const before = process.env.SPOOCHIE_DAEMON_CMD;
  try {
    // `SPOOCHIE_DAEMON_CMD` splits on spaces (it is the tests' hook), so the odd
    // directory has none. What is under test is the escaping, not that hook.
    process.env.SPOOCHIE_DAEMON_CMD = "/opt/copias&backups/bin/bun run <daemon>.ts";
    const { wantedPlist } = await import("../src/startup.ts");
    const f = join(mkdtempSync(join(tmpdir(), "sp-plist-")), "p.plist");
    const text = wantedPlist();
    writeFileSync(f, text);
    expect(text).toContain("copias&amp;backups");
    expect(text).toContain("&lt;daemon&gt;");
    const r = spawnSync("plutil", ["-lint", f], { encoding: "utf8" });
    expect((r.stdout + r.stderr).trim()).toEndWith("OK");
  } finally {
    if (before === undefined) delete process.env.SPOOCHIE_DAEMON_CMD; else process.env.SPOOCHIE_DAEMON_CMD = before;
  }
});

/**
 * Whatever is recorded in the agent stays there forever.
 *
 * It used to get the whole `process.env.PATH`: the PATH of the shell someone once ran
 * `register` from. It can carry the `bin` of a worktree, a nix shell or a test, and the
 * agent uses it on every boot of the machine. A `bun` that shows up there later gets run
 * by the daemon.
 */
test("the agent PATH is the stable one plus the bun in use, not the shell's", async () => {
  const { agentPath } = await import("../src/startup.ts");
  const p = agentPath(["/opt/homebrew/bin/bun", "run", "daemon.ts"]);
  expect(p.split(":")[0]).toBe("/opt/homebrew/bin");
  expect(p).toContain("/usr/bin");
  // Nothing temporary from the installer's shell.
  expect(agentPath(["/usr/bin/bun"], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(agentPath(["bun", "run", "x"], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
});

/**
 * The daemon has to be able to find `claude`.
 *
 * 0.9.9 left the LaunchAgent's PATH as "system directories plus bun's", and Claude Code's
 * native installer puts `claude` in ~/.local/bin. Result, on 10-01 on Edu's machine: he
 * accepts a spoochie from Javi, the aside window opens and says
 * `exec: claude: not found`; in the background, `Executable not found in $PATH: "claude"`.
 * No accepted spoochie could be handled. The tests did not see it because they use a fake
 * `claude` placed in the test's own PATH.
 */
test("the agent PATH includes the directory where claude lives, and nothing else from outside the system", async () => {
  const { agentPath, findClaude } = await import("../src/startup.ts");
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "sp-claude-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho ok\n"); chmodSync(join(bin, "claude"), 0o755);
  // A directory with a `claude` file that is NOT executable does not count.
  const inert = join(home, "inert"); mkdirSync(inert);
  writeFileSync(join(inert, "claude"), "x");

  expect(findClaude([inert, "/does/not/exist", bin])).toBe(bin);
  expect(findClaude([inert, "/does/not/exist"])).toBeNull();

  const path = agentPath(["/usr/local/bin/bun", "run", "x"], undefined, bin);
  expect(path.split(":")).toContain(bin);
  // And from that PATH, a real shell finds it.
  const r = (await import("node:child_process")).spawnSync("/bin/sh", ["-c", "command -v claude"], { env: { PATH: path }, encoding: "utf8" });
  expect(r.stdout.trim()).toBe(join(bin, "claude"));
  // With no claude in sight, the PATH is the old one: no directory is made up.
  expect(agentPath(["/usr/local/bin/bun"], undefined, null)).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

test("doctor fails if the daemon PATH cannot find claude, and says how to fix it", async () => {
  const { claudeCheck } = await import("../src/doctor.ts");
  const { findClaude } = await import("../src/startup.ts");
  // What the 0.9.9 plist had on Edu's machine.
  const bad = claudeCheck("/Users/x/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", () => null)!;
  expect(bad.ok).toBe(false);
  expect(bad.detail).toContain("not in");
  expect(bad.detail).toContain("spoochie register");
  expect(claudeCheck("/a:/b", d => (d.includes("/b") ? "/b" : null))).toMatchObject({ ok: true, detail: "/b/claude" });
  // Without a LaunchAgent there is no daemon PATH to look at, and no failure is made up.
  expect(claudeCheck(null, findClaude)).toBeNull();
});
