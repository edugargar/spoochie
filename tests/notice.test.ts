import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { windowScript, parts, clip, requestedPosition, WIDTH, BUTTONS } from "../src/window.ts";
import { plazo } from "./wait.ts";

const thread = (extra: any = {}): any => ({
  id: "v1", subject: "saving blows up",
  from: { sessionId: "slack:U1", name: "ana", human: "Ana", cwd: "/x" },
  to: { sessionId: "S", name: "repo", cwd: "/y" },
  context: { branch: "feat/x", files: ["a.ts", "b.ts"] },
  messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "look at your Button" }],
  ...extra,
});

/** The data literal the script carries at the top. */
function data(script: string): any {
  const l = script.split("\n").find(x => x.startsWith("var D = "))!;
  return JSON.parse(l.slice("var D = ".length, -1));
}

test("the notice says who is calling first, and only paints the context that exists", () => {
  const p = parts(thread());
  expect(p.quien).toBe("Ana is calling.");
  // The subject starts with a capital even if whoever wrote it did not use one.
  expect(p.asunto).toBe("Saving blows up");
  expect(p.contexto).toBe("feat/x · 2 files");
  expect(p.cita).toBe("look at your Button");
  // No form labels and no jokey lead-ins.
  expect(JSON.stringify(p)).not.toContain("Subject:");
  expect(JSON.stringify(p)).not.toContain("Poochie");
  // With no branch or files there is no empty line waiting for text.
  expect(parts(thread({ context: {} })).contexto).toBe("");
  expect(parts(thread({ context: { files: ["only.ts"] } })).contexto).toBe("1 file");
});

test("a long body is cut after a period, not mid-word", () => {
  const long = "A sentence that takes up some room and ends here. ".repeat(12);
  const c = clip(long);
  expect(c.length).toBeLessThan(long.length);
  expect(c).toMatch(/\.\s…$/);
  expect(clip("  short  ")).toBe("short");
});

/**
 * The important part of this file.
 *
 * Another person writes the subject and the message, and they end up inside a program
 * this process runs. They go in a JSON literal at the top and are not interpolated
 * through the body, so a quote and a semicolon close nothing: they stay the content of
 * a string. It is the same rule as the gatekeeper.
 */
test("another person's text travels as data, not as code", () => {
  const poison = `"; $.NSApplication.sharedApplication.terminate(null); //`;
  const g = windowScript(thread({ subject: poison, messages: [{ at: 1, from: "x", author: "claude", kind: "text", text: poison }] }), null);
  const d = data(g);
  expect(d.asunto).toContain("terminate");
  expect(d.cita).toContain("terminate");
  // And outside the data literal, not a trace: nothing from outside reaches the body.
  const body = g.split("\n").filter(l => !l.startsWith("var D = ")).join("\n");
  expect(body).not.toContain("terminate");
});

test("the three buttons, with Return on the one that accepts", () => {
  const d = data(windowScript(thread(), null));
  expect(d.buttons.map((b: any) => b.title)).toEqual([BUTTONS.rechazar, BUTTONS.slack, BUTTONS.aceptar]);
  expect(d.buttons.find((b: any) => b.title === BUTTONS.aceptar).key).toBe("\r");
  expect(d.width).toBe(WIDTH);
  // The tags are what the script returns on stdout, and they have to be distinct.
  expect(new Set(d.buttons.map((b: any) => b.tag)).size).toBe(3);
});

test("the position is only accepted if it is two numbers", () => {
  const before = process.env.SPOOCHIE_WINDOW_POS;
  try {
    delete process.env.SPOOCHIE_WINDOW_POS;
    expect(requestedPosition()).toBeNull();
    process.env.SPOOCHIE_WINDOW_POS = "200, 160";
    expect(requestedPosition()).toEqual({ x: 200, y: 160 });
    process.env.SPOOCHIE_WINDOW_POS = "top left";
    expect(requestedPosition()).toBeNull();
  } finally {
    if (before === undefined) delete process.env.SPOOCHIE_WINDOW_POS; else process.env.SPOOCHIE_WINDOW_POS = before;
  }
});

/**
 * The script is JavaScript, and a syntax error here does not show until a real
 * spoochie arrives and the person never finds out. `osascript -c` does not exist, but
 * `Function()` compiles without running, and that is enough for a syntax error.
 */
test("the script compiles as JavaScript", () => {
  const g = windowScript(thread({ subject: "accents: ñ á “quotes” and \\ backslashes" }), "/tmp/does-not-exist.png");
  expect(() => new Function(g)).not.toThrow();
});

test.if(process.platform === "darwin")("and macOS understands it: JXA reads it whole without running it", () => {
  // `osascript` with the window inside would sit waiting for someone to press. It gets
  // the script cut right before painting: if what comes before had a syntax error or a
  // class this macOS lacks, it would show here.
  const g = windowScript(thread(), null).split("if (D.click) {")[0];
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", g + `console.log("built:" + height);`], { encoding: "utf8" });
  expect(r.stdout + r.stderr).toContain("built:");
  expect(r.status).toBe(0);
}, plazo(20_000));

/**
 * The real click, out of sight.
 *
 * Until 01-10 the window was tested with screenshots and by reading the script, never
 * by pressing a button. `runModalForWindow` returns the code as a STRING ("3"), the
 * script compared it with `===` against the number 3, and the button name came out
 * empty: the person pressed accept, the daemon read "button returned:" and logged it as
 * "no answer". One person opened a spoochie, the other got the notice, pressed accept
 * and nothing happened.
 *
 * With SPOOCHIE_WINDOW_CLICK the real window comes out transparent, with no Dock icon
 * and no focus, and a timer presses the button. What it prints is read, which is what
 * the daemon reads. It needs AppKit: only on a Mac with a graphical session, and not in CI.
 */
const withScreen = process.platform === "darwin" && !process.env.CI;
const frontmostNow = () => spawnSync("osascript", ["-l", "JavaScript", "-e",
  "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js"], { encoding: "utf8" }).stdout.trim();

/** Runs the script and watches who is frontmost while the window exists. The person
 *  switching apps on their own is not the window's doing: what must not happen is the
 *  window putting itself in front. */
async function runAndWatchFocus(script: string) {
  const { spawn } = await import("node:child_process");
  const child = spawn("osascript", ["-l", "JavaScript", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", d => { output += d.toString(); });
  child.stderr.on("data", d => { output += d.toString(); });
  const done = new Promise<number | null>(r => child.on("close", r));
  const front = new Set<string>();
  let finished = false;
  void done.then(() => { finished = true; });
  // With one await per lap: without it the loop never yields, the child's `close` never
  // reaches `finished` and the test hung until the deadline (60 s, three times).
  while (!finished) { front.add(frontmostNow()); await new Promise(r => setTimeout(r, 20)); }
  return { output, code: await done, front };
}

for (const [title, tag, expected] of [[BUTTONS.aceptar, 3, "acepto"], [BUTTONS.rechazar, 1, "rechazo"], [BUTTONS.slack, 2, "slack"]] as const) {
  test.if(withScreen)(`pressing "${title}" in the real window reaches the daemon as ${expected}, every time and without taking focus`, async () => {
    const { interpret } = await import("../src/dialog.ts");
    process.env.SPOOCHIE_WINDOW_CLICK = String(tag);
    let script: string;
    try { script = windowScript(thread({ id: `click${tag}` })); } finally { delete process.env.SPOOCHIE_WINDOW_CLICK; }
    // Several laps: on 01-10 one click in six gave the wrong button.
    for (let i = 0; i < 6; i++) {
      const r = await runAndWatchFocus(script);
      expect(r.output).toContain(`button returned:${title}`);
      expect(interpret(r.output, r.code)).toBe(expected);
      // Neither osascript nor the window got in front of what the person was doing.
      expect([...r.front].filter(n => /osascript|Script Editor/i.test(n))).toEqual([]);
    }
  }, plazo(60_000));
}

test("without SPOOCHIE_WINDOW_CLICK the production script has no automatic click and is not invisible", () => {
  delete process.env.SPOOCHIE_WINDOW_CLICK;
  const g = windowScript(thread());
  expect(data(g).click).toBe(0);
  // The test block exists in the script, but behind `if (D.click)`: with 0 it does not run.
  expect(g).toContain("if (D.click) {");
  process.env.SPOOCHIE_WINDOW_CLICK = "9";
  try { expect(data(windowScript(thread())).click).toBe(0); } finally { delete process.env.SPOOCHIE_WINDOW_CLICK; }
});
