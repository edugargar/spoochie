/**
 * The notice for an incoming spoochie, outside any terminal.
 *
 * The invitation used to land in the Claude session where the person was working, and
 * that dirtied exactly the terminal nobody should touch: their Claude started talking
 * about the spoochie in the middle of something else. Now, on macOS, the notice is a
 * system window: who opens it, the subject, what they said, and three buttons. Accept
 * opens the aside Claude's window; Decline closes the tunnel; Open in Slack opens the
 * thread, where you can also accept by typing. No interactive session finds out.
 *
 * How that window gets painted lives in `window.ts`. This file holds the outside part:
 * picking the painter, reading the button, and the fallback.
 *
 * Without a desktop (Linux, tests) delivery goes back to the terminal. SPOOCHIE_NOTICE
 * sets it: "terminal", "dialog", or a program that gets the text and answers with the
 * button name (for the tests).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as T from "./threads.ts";
import * as V from "./window.ts";
// The logo, as the notice icon. With `type: "file"` Bun bundles it into the compiled
// binary and a valid path arrives here in both cases, source or binary.
import poochie from "../docs/spoochie.png" with { type: "file" };
import { envVar } from "./paths.ts";

// The daemon writes the answer to its log and scripts/real-test.ts reads it back from there.
export type Answer = "accept" | "decline" | "slack" | null;
export type Mode = "dialog" | "terminal";

export function noticeMode(): Mode {
  const v = envVar("SPOOCHIE_NOTICE", "SPOOCHIE_AVISO");
  if (v === "terminal") return "terminal";
  if (v && v !== "dialog") return "dialog";
  return process.platform === "darwin" ? "dialog" : "terminal";
}

/**
 * The notice as plain text.
 *
 * The native window places each piece on its own; this is the single-column version,
 * which is what the fallback (`display dialog`) and the test program get. Both come
 * from `V.parts`, so they cannot say different things.
 */
export function dialogParts(t: T.Thread): { titular: string; cuerpo: string } {
  const p = V.parts(t);
  return {
    titular: p.quien,
    cuerpo: [p.asunto, p.contexto || null, ``, `“${p.cita}”`, ``, p.pie.replace(/\n/g, " ")]
      .filter(x => x !== null).join("\n"),
  };
}

/** All in one piece, for the box that does not separate headline from body (and for the tests). */
export function dialogText(t: T.Thread): string {
  const { titular, cuerpo } = dialogParts(t);
  return `${titular}\n\n${cuerpo}`;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const BUTTONS = V.BUTTONS;

/** What a custom notice program may print on a line of its own. The Spanish words are
 *  the labels up to 0.9.10, still read so an older program keeps working. */
const ACCEPT_WORDS = /^\s*(Let it in|Accept|Aceptar|Que pase)\s*$/m;
const SLACK_WORDS = /^\s*(Open in Slack|Ver en Slack)\s*$/m;
const DECLINE_WORDS = /^\s*(Not now|Decline|Rechazar|Ahora no)\s*$/m;

export function interpret(output: string, code: number | null): Answer {
  if (/gave up:true/.test(output)) return null;
  if (output.includes(`button returned:${BUTTONS.accept}`) || ACCEPT_WORDS.test(output)) return "accept";
  if (output.includes(`button returned:${BUTTONS.slack}`) || SLACK_WORDS.test(output)) return "slack";
  if (output.includes(`button returned:${BUTTONS.decline}`) || DECLINE_WORDS.test(output)) return "decline";
  // The cancel button makes osascript exit with the error "User canceled".
  if (code !== 0 && /canceled|cancelled|-128/i.test(output)) return "decline";
  return null;
}

/**
 * The fallback: the plain old AppleScript box.
 *
 * Used only if the window program does not start. That is not hypothetical: `NSWindow`,
 * `NSVisualEffectView` and `ObjC.registerSubclass` come from the system, and a macOS
 * version that changes any of the three leaves the person with no notice at all. An
 * ugly notice is far better than a spoochie nobody sees arrive.
 *
 * `display alert`, which separates headline from body, was tried and rejected: it
 * takes no custom icon (you get osascript's generic orange folder), the box is narrower
 * and breaks the sentences, and the three buttons stack vertically, which makes it look
 * like a system error instead of someone calling.
 */
export function osascriptScript(t: T.Thread, waitSec = 3600): string {
  const icon = existsSync(poochie) ? ` with icon POSIX file "${esc(poochie)}"` : "";
  return `display dialog "${esc(dialogText(t))}" with title "spoochie"${icon}`
    + ` buttons {"${BUTTONS.decline}", "${BUTTONS.slack}", "${BUTTONS.accept}"}`
    + ` default button "${BUTTONS.accept}" cancel button "${BUTTONS.decline}" giving up after ${waitSec}`;
}

/** The window's JXA program, with the icon if it exists. */
export function windowScript(t: T.Thread): string {
  return V.windowScript(t, existsSync(poochie) ? poochie : null);
}

type Notice = { close: () => void; answer: Promise<Answer> };

function run(cmd: string, args: string[]): { child: ChildProcess; done: Promise<{ output: string; code: number | null }> } {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", d => { output += d.toString(); });
  child.stderr?.on("data", d => { output += d.toString(); });
  const done = new Promise<{ output: string; code: number | null }>(resolve => {
    child.on("error", () => resolve({ output, code: -1 }));
    child.on("close", code => resolve({ output, code }));
  });
  return { child, done };
}

/**
 * Shows the notice and waits for the button. Up to an hour; if nobody presses, null.
 *
 * This side keeps the clock instead of `giving up after`, because the native window has
 * no such clause, and with a timer here both paths expire the same way. Killing the
 * child gives the same null as AppleScript's "gave up:true".
 */
export function ask(t: T.Thread, waitSec = 3600): Notice {
  const custom = envVar("SPOOCHIE_NOTICE", "SPOOCHIE_AVISO");
  let live: ChildProcess | null = null;
  let killed = false;
  const cerrar = () => { killed = true; try { live?.kill(); } catch {} };

  const respuesta = (async (): Promise<Answer> => {
    if (custom && custom !== "dialog") {
      const { child, done } = run(custom, [dialogText(t)]);
      live = child;
      const r = await done;
      return interpret(r.output, r.code);
    }
    const win = run("osascript", ["-l", "JavaScript", "-e", windowScript(t)]);
    live = win.child;
    const r = await win.done;
    const read = interpret(r.output, r.code);
    if (read !== null || killed || r.code === 0) return read;
    // The window never got painted. Say so in the daemon log through stderr and ask
    // again with the usual box.
    console.error("spoochie: the notice window did not start, falling back to the plain dialog:", r.output.trim().split("\n")[0] ?? "");
    const box = run("osascript", ["-e", osascriptScript(t, waitSec)]);
    live = box.child;
    const r2 = await box.done;
    return interpret(r2.output, r2.code);
  })();

  const timer = setTimeout(cerrar, waitSec * 1000);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  void respuesta.then(() => clearTimeout(timer));
  return { close: cerrar, answer: respuesta };
}

/**
 * A system notification, no buttons. For what the person has to know but does not
 * have to answer right now.
 *
 * The text goes in as an `on run argv` argument, never pasted inside the script: part
 * of what is shown comes from an outside envelope, and with quotes in a name the script
 * would be theirs. Without a desktop, or with SPOOCHIE_NOTICE set (the tests), it does
 * nothing.
 */
export function notify(title: string, text: string): boolean {
  if (process.platform !== "darwin" || envVar("SPOOCHIE_NOTICE", "SPOOCHIE_AVISO")) return false;
  const script = "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run";
  const p = spawn("osascript", ["-e", script, title, text], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
  return true;
}

/** Opens the spoochie's thread in the Slack app. */
export function openInSlack(teamId: string | null, channel: string, ts: string) {
  const url = teamId
    ? `slack://channel?team=${teamId}&id=${channel}&message=${ts.replace(".", "")}`
    : `https://slack.com/app_redirect?channel=${channel}`;
  const p = spawn("open", [url], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
}
