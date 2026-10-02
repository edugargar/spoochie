/**
 * When to send my Nostr key over Slack to a contact who does not have theirs.
 *
 * It used to be "once per contact per start", in memory: every Claude Code restart starts
 * the daemon again and it sent the DM again. Seen live: two DMs to the same person in 35
 * seconds. Now the time it went to each one is written to disk and it does not repeat for
 * a day, which is how long someone who has not updated takes to do it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs } from "./paths.ts";

export const HELLOS_FILE = join(ROOT, "holas.json");
export const HELLO_EVERY_MS = 24 * 3600 * 1000;

function readAll(): Record<string, number> {
  try { return existsSync(HELLOS_FILE) ? JSON.parse(readFileSync(HELLOS_FILE, "utf8")) : {}; } catch { return {}; }
}

/** True if this contact has not been sent the key in the last day; and writes it down. */
export function helloDue(id: string, now = Date.now()): boolean {
  const h = readAll();
  if (h[id] && now - h[id] < HELLO_EVERY_MS) return false;
  h[id] = now;
  ensureDirs();
  try { writeFileSync(HELLOS_FILE, JSON.stringify(h), { mode: 0o600 }); } catch {}
  return true;
}

/** They have a key now: nothing to remember about them. */
export function forgetHello(id: string) {
  const h = readAll();
  if (!(id in h)) return;
  delete h[id];
  try { writeFileSync(HELLOS_FILE, JSON.stringify(h), { mode: 0o600 }); } catch {}
}
