import { expect, test } from "bun:test";
import * as Cfg from "../src/config.ts";
import { levelOf, autoAccepts } from "../src/trust.ts";

/**
 * Everything new ships off.
 *
 * There are no server flags to roll out by percentage: spoochie ships
 * as one binary per plugin version, so updating changes the behavior for
 * everyone at once. The only thing that keeps a new feature from surprising someone is that
 * it's born off and gets turned on by hand. This test checks it on a freshly
 * created config, which is what someone who just installed has.
 */
test("a new config has none of the new features turned on", () => {
  const c: Cfg.Config = { guardian: true, transcript: false };

  // Permanent consent: nobody gets in without a dialog until you say so.
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/x/repo")).toBe(false);
  // Trust: everyone starts at normal.
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("normal");
  // Keychain: the secrets stay where they were until `spoochie llavero on` is run.
  expect(c.keys?.priv).toBeUndefined();
  // Groups and continuations: they only exist if the flag is asked for.
  expect((c as any).grupo).toBeUndefined();
});

test("the three things that DO ship on are controls, not features", async () => {
  // The difference matters: a new feature turned off respects what the tool already
  // did; a control off by default protects nobody.
  const aside = await Bun.file(new URL("../src/aside.ts", import.meta.url)).text();
  // The gatekeeper and the sentinel go in the startup settings, unconditionally.
  expect(aside).toContain("PreToolUse: [");
  expect(aside).toContain("Stop: [");
  expect(aside).not.toContain("if (Cfg.load().portero");
  expect(aside).not.toContain("if (Cfg.load().gatekeeper");
  // The watcher already came on by default and still does.
  const cfg = await Bun.file(new URL("../src/config.ts", import.meta.url)).text();
  expect(cfg).toContain("const DEFAULTS: Config = { guardian: true");
});

test("the screenshot script crops the window, and what is full screen sits behind a flag", async () => {
  // Measured twice: capturing the whole screen first grabbed the Accessibility
  // permission dialog and then the desktop of whoever ran it, with whatever windows
  // they had open. In a tool whose whole argument is that things don't
  // leak, that can't happen by default.
  const s = await Bun.file(new URL("../scripts/screenshots.ts", import.meta.url)).text();
  // The notice no longer needs the screen: it's placed where we say and its exact
  // rectangle is cropped, with a zero frame so not even a strip of what's behind gets in.
  expect(s).toContain("SPOOCHIE_WINDOW_POS");
  expect(s).toContain("FRAME = 0");
  expect(s).toContain('spawnSync("screencapture", ["-x", "-R"');
  // The aside window is a Terminal and can't be placed: that one is full
  // screen, sits behind the flag, and at the end it reminds you to look at the PNG.
  expect(s).toContain('process.argv.includes("--full-screen")');
  expect(s).toContain("if (!fullScreen)");
  expect(s).toContain("LOOK AT 2-aside.png before showing it to anyone");
  // And the only `screencapture` without a region is inside that branch.
  const [before, after] = s.split("if (!fullScreen)");
  expect(before).not.toContain('screencapture", ["-x", whole]');
  expect(after).toContain('screencapture", ["-x", whole]');
});

test("no aside is launched before the person accepts", async () => {
  // We considered getting ahead on the work while the dialog waits. Rejected: it spends your
  // money on a question you haven't accepted, and "nothing happens until you accept" stops
  // being true if a Claude is already reading your repo because of someone else's question.
  const d = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
  const dialog = d.slice(d.indexOf("function askWithDialog"), d.indexOf("function closeDialog"));
  expect(dialog).not.toContain("Ap.launch");
  expect(dialog).not.toContain("attend(");
  // And the reason is written where the decision would be made, not in a commit nobody reads.
  const reason = d.slice(d.indexOf("We considered launching the aside RIGHT AWAY"), d.indexOf("function askWithDialog"));
  expect(reason).toContain("REJECTED");
  expect(reason).toContain("It spends your money on a question you haven't accepted");
});

test("the aside's tools go in its main session, not in a subagent", async () => {
  // `--agents` defines subagents to dispatch to; the aside is the main session
  // of its own process. Declaring it there would leave unrestricted exactly the one reading the repo.
  const b = await import("../src/aside.ts");
  const flags = b.asideFlags("v1", "/x/spoochie");
  expect(flags).not.toContain("--agents");
  expect(flags).toContain("--allowedTools");
  expect(flags).toContain("--disallowedTools");
  // And the reason written where the decision would be made (the comment does name --agents).
  const a = await Bun.file(new URL("../src/aside.ts", import.meta.url)).text();
  expect(a).toContain("it defines SUBagents the session can dispatch to");
});

test("each README promise names the test that proves it, and that test exists", async () => {
  // A promise without a check is advertising. This doesn't check that the promise is
  // true (the named tests do that), it checks that the README can't
  // promise something pointing at a file that's no longer there.
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const table = readme.slice(readme.indexOf("## The promises"), readme.indexOf("## Security model"));
  expect(table).toContain("No server of ours");
  expect(table).toContain("The model is yours");
  expect(table).toContain("Closing deletes it");
  for (const f of ["tests/two-machines-nostr.test.ts", "tests/relay.test.ts", "tests/slack.test.ts", "src/guardian.ts"]) {
    expect(table).toContain(f);
    expect(await Bun.file(new URL(`../${f}`, import.meta.url)).exists()).toBe(true);
  }
});

/**
 * A closed spoochie doesn't keep the text, whenever it was closed.
 *
 * "Closing deletes it" is one of the README's three promises and whoever closes keeps it,
 * but an earlier version could close without sweeping. Measured on a real machine:
 * `spoochie doctor` reported a failure with twelve closed spoochies that still kept what was
 * said, from August 30 to September 4, and there was no way to fix it. The rule isn't
 * "deleted if that day's version did it": it's that a closed one doesn't keep it.
 */
test("on startup the daemon sweeps closed threads that still keep text", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { hasta } = await import("./wait.ts");

  const home = mkdtempSync(join(tmpdir(), "sp-sweep-"));
  mkdirSync(join(home, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: false, human: "Edu" }), { mode: 0o600 });
  const file = join(home, "threads", "old.json");
  writeFileSync(file, JSON.stringify({
    id: "old", subject: "from before", state: "closed", createdAt: 1, lastActivityAt: 1, closedAt: 1,
    from: { sessionId: "slack:U_A", name: "Ana", cwd: "(other)" },
    to: { sessionId: "slack:U_B", name: "me", cwd: "(this)" },
    context: {}, messages: [{ at: 1, from: "slack:U_A", author: "claude", kind: "text", text: "this shouldn't still be here" }],
  }));
  // And an open one, which isn't touched: what gets swept is the closed ones.
  const live = join(home, "threads", "live.json");
  writeFileSync(live, JSON.stringify({
    id: "live", subject: "in progress", state: "open", createdAt: 1, lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_A", name: "Ana", cwd: "(other)" },
    to: { sessionId: "slack:U_B", name: "me", cwd: "(this)" },
    context: {}, messages: [{ at: 1, from: "slack:U_A", author: "claude", kind: "text", text: "this does stay here" }],
  }));

  const d = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_WINDOW: "background" }, stdio: "ignore",
  });
  try {
    const withText = (f: string) => JSON.parse(readFileSync(f, "utf8")).messages.filter((m: { text?: string }) => m.text).length;
    expect(await hasta(() => withText(file) === 0)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).borrado).toBeTruthy();
    expect(withText(live)).toBe(1);
  } finally {
    d.kill("SIGKILL");
  }
});
