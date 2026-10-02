/**
 * Files between machines, screenshots mostly.
 *
 * On one machine a file travels as an absolute path, and the Claude on the other end
 * opens it with its own permissions. Across machines that path does not exist, so the
 * bytes go through Slack: the bot uploads them to the thread and the daemon on the
 * other side downloads them to its own spool before handing the path to its session.
 *
 * We do NOT use the Claude Code inbox's `file_attachments`. It exists, but it is
 * undocumented and has its own spool and integrity rules. Here the file also shows up
 * in the thread, which is where people look.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join, extname } from "node:path";
import { ROOT } from "./paths.ts";

const API = "https://slack.com/api/";
/** A deliberate limit: spoochie is for hints, not for moving binaries around. */
export const MAX_BYTES = 10 * 1024 * 1024;
export const SPOOL = join(ROOT, "files");

const safe = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";

export type Uploaded = { id: string; nombre: string };

/** Uploads a file to the thread. Returns null if it is too big or Slack says no. */
export async function upload(token: string, path: string, channel: string, threadTs: string): Promise<Uploaded | null> {
  let bytes: Buffer;
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    bytes = readFileSync(path);
  } catch { return null; }
  const name = safe(basename(path));

  const auth = { authorization: `Bearer ${token}` };
  const step1 = await fetch(`${API}files.getUploadURLExternal?${new URLSearchParams({ filename: name, length: String(bytes.length) })}`, { headers: auth });
  const j1 = await step1.json();
  if (!j1.ok) return null;

  const step2 = await fetch(j1.upload_url, { method: "POST", body: new Blob([bytes as unknown as BlobPart]) });
  if (!step2.ok) return null;

  const step3 = await fetch(`${API}files.completeUploadExternal`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ files: [{ id: j1.file_id, title: name }], channel_id: channel, thread_ts: threadTs }),
  });
  const j3 = await step3.json();
  return j3.ok ? { id: j1.file_id, nombre: name } : null;
}

/**
 * Where we accept bytes from with the bot token attached.
 *
 * `download` sends `Authorization: Bearer <bot token>` to whatever URL the message's
 * `url_private` field says. Today the Slack API sets that field over TLS, so there is
 * no open hole; the problem is that the function relies on that without checking it.
 * A URL on another host walks away with the whole team's token.
 */
const HOSTS = /^https:\/\/([a-z0-9-]+\.)*slack(-files)?\.com\//i;

/** Downloads a message's files to the spool and returns their local paths. */
export async function download(token: string, files: any[], threadId: string): Promise<string[]> {
  // The id arrives validated by `VALID_ID` once the thread is materialized, but this
  // function does not know that: here it ends up in a `join`, and an id with `../`
  // writes outside the spool. Clean it anyway; it costs one line and depends on no one.
  const dir = join(SPOOL, safe(threadId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const f of files ?? []) {
    const url = f?.url_private_download ?? f?.url_private;
    if (typeof url !== "string" || !HOSTS.test(url)) continue;
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;
      // The sender picks the name: clean it before it touches the disk.
      const name = safe(f.name ?? `${f.id}${extname(f.filetype ? `.${f.filetype}` : "")}`);
      // The other side picks the id too. Uncleaned, an id with ../ writes outside the
      // spool, which is worse than an ugly name.
      const dest = join(dir, `${safe(String(f.id ?? "s"))}-${name}`);
      writeFileSync(dest, buf, { mode: 0o600 });
      paths.push(dest);
    } catch {}
  }
  return paths;
}

/**
 * Whatever someone left parked in the spool of a thread that never came to exist.
 *
 * Files travel in chunks and relays do not keep order, so a chunk can arrive before
 * the invite and has to wait here. Fine so far. What nobody planned for is the invite
 * never arriving: the daemon's sweep walks the threads, and nobody looks after a thread
 * that does not exist. Measured: a contact sends a file with a made-up id and it sits
 * in the spool forever, never showing up anywhere a person would see it.
 *
 * It also breaks the rule everything else rests on: nothing happens until you accept.
 * Someone else's file on your disk before you were asked means something did happen.
 *
 * It gets the same treatment as an unaccepted spoochie. A directory with a live thread
 * is left alone: `purge` handles that one on close.
 */
export function sweepOrphans(hasThread: (id: string) => boolean, ttlMs: number, now = Date.now()): string[] {
  if (!existsSync(SPOOL)) return [];
  const swept: string[] = [];
  for (const id of readdirSync(SPOOL)) {
    if (hasThread(id)) continue;
    const dir = join(SPOOL, id);
    try {
      if (now - statSync(dir).mtimeMs < ttlMs) continue;
      rmSync(dir, { recursive: true, force: true });
      swept.push(id);
    } catch {}
  }
  return swept;
}
