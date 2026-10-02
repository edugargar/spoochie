/**
 * Outbox with merging, kept on disk.
 *
 * A Claude that thinks the channel truncates sends its answer as 23 messages in a row, and
 * in Slack that is a wall of numbered chunks. Text messages from the same side that
 * land in the same window go out as one. Two and a half seconds go unnoticed
 * next to how long a model takes to think.
 *
 * What is pending is written to ~/.claude/spoochie/outbox.json: a daemon restart (an
 * update, launchd relaunching it) no longer loses the messages that were
 * waiting for their window, nor the ones Slack rejected; on startup they resume, and what
 * fails is retried every minute until it goes out.
 *
 * It lives apart from the daemon because importing daemon.ts starts a daemon, and this is
 * easier to test without one.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import * as T from "./threads.ts";
import { OUTBOX_FILE, ensureDirs, writeAtomic } from "./paths.ts";

export const MERGE_MS = 2_500;
export const RETRY_MS = 60_000;

export type Send = (t: T.Thread, m: T.Msg) => Promise<boolean | void>;

type Box = { msgs: T.Msg[]; timer: ReturnType<typeof setTimeout> | null; fails: number };
const outbox = new Map<string, Box>();
let defaultSend: Send | null = null;
let retry: ReturnType<typeof setInterval> | null = null;

function persist() {
  ensureDirs();
  // `fallos` is the key already on users' disks: it stays.
  const data = [...outbox].map(([key, b]) => ({ key, msgs: b.msgs, fallos: b.fails }));
  try {
    if (data.length) writeAtomic(OUTBOX_FILE, JSON.stringify(data));
    else if (existsSync(OUTBOX_FILE)) unlinkSync(OUTBOX_FILE);
  } catch {}
}

function merge(msgs: T.Msg[]): T.Msg {
  const merged: T.Msg = {
    ...msgs[0],
    text: msgs.map(x => x.text).join("\n\n"),
    // The files of ALL merged messages, not just the first one's:
    // merging used to drop the attachments of the ones that came after.
    files: msgs.flatMap(x => x.files ?? []).filter((f, i, a) => a.indexOf(f) === i),
  };
  if (!merged.files?.length) delete merged.files;
  return merged;
}

async function flush(key: string, send: Send) {
  const box = outbox.get(key);
  if (!box) return;
  box.timer = null;
  const fresh = T.load(key.split(":")[0]);
  if (!fresh) { outbox.delete(key); persist(); return; }
  let ok: boolean | void = false;
  try { ok = await send(fresh, merge(box.msgs)); } catch { ok = false; }
  if (ok === false) { box.fails++; persist(); return; }
  outbox.delete(key);
  persist();
}

/** Queues a message; it goes out only once the merge window passes with no other arriving. */
export function enqueue(t: T.Thread, m: T.Msg, send: Send, windowMs = MERGE_MS) {
  const key = `${t.id}:${m.from}`;
  // A patch or a branch merges with nothing: it goes as is.
  if (m.kind !== "text") { void send(t, m); return; }
  const box = outbox.get(key) ?? { msgs: [], timer: null, fails: 0 };
  if (box.timer) clearTimeout(box.timer);
  box.msgs.push(m);
  outbox.set(key, box);
  persist();
  box.timer = setTimeout(() => { void flush(key, send); }, windowMs);
}

/** What a previous daemon left on disk goes out now; what fails, every minute. */
export function resume(send: Send): number {
  defaultSend = send;
  let n = 0;
  if (existsSync(OUTBOX_FILE)) {
    try {
      for (const d of JSON.parse(readFileSync(OUTBOX_FILE, "utf8")) as { key: string; msgs: T.Msg[]; fallos?: number }[]) {
        if (!d.msgs?.length || outbox.has(d.key)) continue;
        outbox.set(d.key, { msgs: d.msgs, timer: null, fails: d.fallos ?? 0 });
        n++;
      }
    } catch {}
    for (const key of [...outbox.keys()]) void flush(key, send);
  }
  if (!retry) {
    retry = setInterval(() => {
      if (!defaultSend) return;
      for (const [key, b] of outbox) if (!b.timer) void flush(key, defaultSend);
    }, RETRY_MS);
    retry.unref();
  }
  return n;
}

/** For tests and `doctor`: how many messages are waiting to go out. */
export function pending(): number {
  return [...outbox.values()].reduce((a, b) => a + b.msgs.length, 0);
}
