#!/usr/bin/env bun
/**
 * Screenshots of the real UI.
 *
 * "The tests pass" is no proof that something looks right. The notice and the aside
 * Claude's window are the two things a person sees, and there was not a single image of
 * either anywhere: they got reviewed by opening them by hand and looking, or not at all.
 *
 *   bun scripts/screenshots.ts [--dir <dest>] [--full-screen]
 *
 * (--pantalla-entera, the old name, still works.)
 *
 * macOS only, because that is where both exist.
 *
 * THE NOTICE is captured on its own. The window is placed somewhere known with
 * SPOOCHIE_WINDOW_POS, prints its height to stdout, and `screencapture -R` crops that
 * rectangle. Nothing but the window fits in the PNG.
 *
 * It was not like this before, and that is why this is written down: capturing a window
 * by its id needs the macOS Accessibility permission, so the first version captured the
 * whole screen and cropped the center. Measured twice: the first attempt grabbed the
 * permission dialog itself, and the second the desktop of whoever ran it, with whatever
 * windows they had open. In a tool whose whole argument is that things do not leak,
 * that could not stay.
 *
 * THE ASIDE WINDOW is still a Terminal, which cannot be placed where we like, so that
 * one is the whole screen cropped to the center. It sits behind `--full-screen` and
 * comes with the reminder to look at the PNG before showing it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowScript } from "../src/dialog.ts";
import { WIDTH } from "../src/window.ts";
import { firstTurn } from "../src/aside.ts";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIR = arg("dir") ?? join(process.cwd(), "screenshots");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fullScreen = process.argv.includes("--full-screen") || process.argv.includes("--pantalla-entera");

if (process.platform !== "darwin") {
  console.error("the screenshots are of the macOS UI: the notice and the aside window only exist there");
  process.exit(1);
}
mkdirSync(DIR, { recursive: true });

/** The sample thread. A realistic one, not "test subject": a screenshot is worth what
 *  it shows, and an empty case does not show whether long text wraps well. */
const THREAD: any = {
  id: "k7f",
  subject: "saving the modal returns 500 on your branch",
  from: { sessionId: "slack:U1", name: "sam", human: "Sam", cwd: "/x" },
  to: { sessionId: "S", name: "anthias", cwd: process.cwd(), human: "Edu" },
  context: { branch: "fix/modal-save", files: ["src/modal.tsx", "src/api/save.ts", "tests/modal.test.ts"] },
  state: "open",
  messages: [{ at: Date.now(), from: "slack:U1", author: "claude", kind: "text", text: "Saving gives me a 500 with no trace. It works on main. Is it your branch or mine?" }],
};

console.log(`screenshots in ${DIR}\n`);

// 1. The notice, cropped to its own rectangle.
{
  // FRAME = 0: the crop is the window's exact rectangle. With a margin you see the
  // shadow, which looks nicer, but you also see a strip of whatever is behind, and at
  // 8 pt that strip already carried readable text from another app. The shadow is not
  // the design.
  const X = 200, Y = 160, FRAME = 0;
  // `windowScript` reads the position from this process, not from the child: the
  // script comes out already written with the coordinates inside. Setting it only in
  // the spawn's env left the window centered, and the crop took whatever was in that
  // corner.
  process.env.SPOOCHIE_WINDOW_POS = `${X},${Y}`;
  const p = spawn("osascript", ["-l", "JavaScript", "-e", windowScript(THREAD)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  p.stdout.on("data", d => { output += d.toString(); });
  p.stderr.on("data", d => { output += d.toString(); });
  // The window itself prints its height once it is painted.
  let height = 0;
  for (let i = 0; i < 60 && !height; i++) {
    await sleep(100);
    height = Number(output.match(/height:(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  }
  if (!height) {
    console.error(`  1-notice       FAILED: the window did not start${output ? `: ${output.trim().split("\n")[0]}` : ""}`);
  } else {
    await sleep(600); // let it finish appearing and applying the glass
    const dest = join(DIR, "1-notice.png");
    const r = spawnSync("screencapture", ["-x", "-R", `${X - FRAME},${Y - FRAME},${WIDTH + FRAME * 2},${Math.ceil(height) + FRAME * 2}`, dest]);
    console.log(r.status === 0 && existsSync(dest) ? `  1-notice       the notice window, ${WIDTH}x${Math.round(height)}` : "  1-notice       FAILED to crop");
  }
  p.kill();
  await sleep(500);
}

// 2. The aside window: a Terminal with the first turn inside. No real Claude is
// launched (it would cost money and take a while); it paints what the person sees when
// the window opens, which is what needs reviewing.
if (!fullScreen) {
  console.log(`  2-aside        skipped. It is a Terminal, and a Terminal cannot be placed where`);
  console.log(`                 we like: it means capturing the whole screen and cropping the center,`);
  console.log(`                 so whatever you have behind ends up in the PNG. Close what you don't`);
  console.log(`                 want in it and come back with --full-screen.`);
} else {
  const script = join(tmpdir(), "sp-cap-aside.command");
  const turn = firstTurn(THREAD, "S", "spoochie", process.cwd(), process.cwd());
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '\\033]0;spoochie ${THREAD.id}\\007'`,
    `echo 'spoochie ${THREAD.id} · ${THREAD.subject}'`,
    `echo 'Aside Claude: read-only + spoochie say. You can type to it here. Closing the window closes the spoochie.'`,
    `echo ''`,
    `cat <<'END'`,
    turn.split("\n").slice(0, 14).join("\n"),
    "END",
    "sleep 12",
    "",
  ].join("\n"), { mode: 0o700 });
  spawnSync("open", ["-a", "Terminal", script]);
  await sleep(4000);
  const whole = join(tmpdir(), "sp-cap-aside.png");
  spawnSync("screencapture", ["-x", whole]);
  const dest = join(DIR, "2-aside.png");
  const r = spawnSync("sips", ["-c", "1100", "1500", whole, "--out", dest], { stdio: "ignore" });
  console.log(r.status === 0 && existsSync(dest) ? `  2-aside        the window with the first turn` : "  2-aside        FAILED");
  console.log(`\n  LOOK AT 2-aside.png before showing it to anyone: it is of the whole screen.`);
  await sleep(500);
}

console.log(`\nThe transcript is not captured here: it is an HTML page published as an Artifact and`);
console.log(`viewed in the browser. \`spoochie transcript <id>\` prints the path.`);
