import { readFileSync, existsSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs, writeAtomic } from "./paths.ts";
import * as L from "./keychain.ts";

export type Config = {
  /** The name others see you by. Defaults to your system user. */
  human?: string;
  /** The topic guardian costs one Haiku call per message. */
  guardian: boolean;
  /** Publish the transcript as an Artifact on open and on every turn. */
  transcript: boolean;
  /** Incoming spoochies are handled by a separate Claude (claude -p in the repo), not the
   *  session you work in. That one only gets the notice. Off, everything goes into your session. */
  aparte?: boolean;
  /** The aside Claude works on a clean copy of the repo (git worktree of HEAD), not on
   *  your checkout: even if something slipped through the tool list, your files are not
   *  touched. Catch: anything uncommitted (.env, local changes) is not in the copy. Off,
   *  it works in the real checkout. */
  aparteCopia?: boolean;
  /** Closing a spoochie deletes the conversation: locally (id, subject, who and when
   *  remain) and on the transport (on Slack, everything the bot posted; what a person
   *  typed by hand stays, the bot cannot delete it). On by default. */
  borrarAlCerrar?: boolean;
  /** Who invited you, and whom you have invited. "@edu" resolves here before asking
   *  Slack, which needs users:read to search by name. */
  contacts?: Record<string, {
    id: string; name: string; pk?: string; npub?: string; relays?: string[];
    /** Trust level. "alto" silences the "off topic" labels, which are noise when you
     *  already know who you are talking to. It never opens the hold on messages that ask
     *  to act: see trust.ts. */
    nivel?: "alto" | "normal";
    /** Standing, scoped consent: names of repos whose spoochies from this person get in
     *  without showing the dialog. Per person AND per repo, never global. */
    auto?: string[];
    /** When their last envelope arrived. It is the closest to "they are there" you can
     *  say without inventing a probe: it does not say whether they are there now, it says
     *  when they were. */
    visto?: number;
  }>;
  /** Unredeemed invites, by nonce: who was invited and when. A hello over Nostr only gets
   *  in with one of these (keys.ts). They expire after 30 days. */
  invitaciones?: Record<string, { id?: string; name?: string; at: number }>;
  /** This person's Nostr keys (secp256k1, hex) and relays. Born at join. */
  nostr?: { sk?: string; pk?: string; relays?: string[] };
  /** How spoochies travel with someone who has a Nostr key: "nostr" (default if both
   *  have one) or "slack". Slack still sends DM notices in both cases. */
  transporte?: "nostr" | "slack";
  /** The ed25519 key envelopes are signed with. Born at join. */
  keys?: { pub: string; priv: string };
  slack?: {
    /** User token (xoxp-) of your Slack app, obtained via OAuth. Yours, not shared.
     *  Empty if you use tokenFile. No longer needed for anything: the bot token is enough. */
    userToken?: string;
    /** JSON file to read the token from, to avoid a second copy to rotate if another
     *  tool of yours already stores one. */
    tokenFile?: string;
    /** Key inside that JSON. Defaults to "userToken". */
    tokenKey?: string;
    /** The app's bot token (xoxb-). It is an app credential, not a personal one: all
     *  spoochie traffic lives in the DM between the bot and each person, which is ONE
     *  channel per machine to poll instead of someone's 197 DMs. */
    botToken?: string;
    botTokenKey?: string;
    /** Your Slack user id, to know which messages in the thread are yours. */
    userId: string;
    /** Where the thread of each spoochie you open lives. "grupo": a group DM with the
     *  bot, you and the other person, which you both see (needs mpim:write, mpim:read and
     *  mpim:history on the app). "canal": a fixed channel (`canal`), which everyone in it
     *  sees. "dm": the DM between the bot and the recipient, which you do not see.
     *  Defaults to "grupo", and if the app lacks the permissions it falls back to "dm"
     *  with a warning. */
    hilos?: "grupo" | "canal" | "dm";
    canal?: string;
    /** How often open threads are polled. */
    pollMs: number;
  };
};

const FILE = join(ROOT, "config.json");
const DEFAULTS: Config = { guardian: true, transcript: false, aparte: true };

const BACKUP = `${FILE}.bak`;

/**
 * Whether the file exists but could not be read. While this is true, `save` does not
 * write: in here are your signing key, your Nostr key, the bot token and your whole
 * contacts list, and saving over something we do not understand loses them for good.
 */
let broken = false;
export const unreadableConfig = () => broken;

function readFrom(path: string): Config | null {
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return null;
    const j = JSON.parse(text);
    return j && typeof j === "object" ? { ...DEFAULTS, ...j } : null;
  } catch { return null; }
}

/**
 * Reads the config. And if it cannot, it says so instead of inventing an empty one.
 *
 * `save` used to truncate and write, so a process killed halfway (a SIGKILL, a power cut,
 * the OOM killer) left the file half written. Probe: with the file cut in half, `load`
 * returned the default config without a word (signing key: none, contacts: empty) and
 * the next `save` wrote over it. So the three keys and every contact were lost, silently
 * and for good. No attacker needed: restarting at the wrong moment is enough.
 *
 * Now `save` writes to the side and renames (rename is atomic on the same disk: either
 * the whole old file is there or the whole new one), keeps a copy of the previous one,
 * and this reads the copy if the good one does not parse.
 */
/** What this process last read, exactly as it was on disk. Tells "I deleted this" apart
 *  from "I never saw this". See `save`. */
let lastRead: string | null = null;

export function load(): Config {
  ensureDirs();
  if (!existsSync(FILE)) { broken = false; lastRead = null; return { ...DEFAULTS }; }
  const c = readFrom(FILE);
  if (c) { broken = false; try { lastRead = readFileSync(FILE, "utf8"); } catch { lastRead = null; } return fillFromKeychain(c); }
  const backup = readFrom(BACKUP);
  if (backup) {
    broken = false;
    console.error(`spoochie: ${FILE} does not parse; carrying on with the backup (${BACKUP}). Look at both before touching anything.`);
    return fillFromKeychain(backup);
  }
  broken = true;
  console.error(`spoochie: ${FILE} does not parse and there is no usable backup. I will NOT write over it: it holds your signing key, your Nostr key, the bot token and your contacts. Put it aside and look at what is inside.`);
  return { ...DEFAULTS };
}

/**
 * Swaps the `@llavero` markers for the real secret. If the keychain does not answer, the
 * marker stays: better for spoochie to say "I have no key" than to sign with the string
 * "@llavero" and have the other side drop the envelopes without knowing why.
 */
export function fillFromKeychain(c: Config): Config {
  const needs = c.keys?.priv === L.MARKER || c.nostr?.sk === L.MARKER || c.slack?.botToken === L.MARKER;
  if (!needs) return c;
  if (c.keys?.priv === L.MARKER) { const v = L.read(L.ACCOUNTS.firma); if (v) c.keys = { ...c.keys, priv: v }; }
  if (c.nostr?.sk === L.MARKER) { const v = L.read(L.ACCOUNTS.nostr); if (v) c.nostr = { ...c.nostr, sk: v }; }
  if (c.slack?.botToken === L.MARKER) { const v = L.read(L.ACCOUNTS.bot); if (v) c.slack = { ...c.slack!, botToken: v }; }
  return c;
}

/** Moves the three secrets to the keychain and leaves the marker in the file. Returns which ones. */
export function toKeychain(c: Config): string[] {
  const moved: string[] = [];
  if (c.keys?.priv && c.keys.priv !== L.MARKER && L.store(L.ACCOUNTS.firma, c.keys.priv)) { c.keys.priv = L.MARKER; moved.push("signing key"); }
  if (c.nostr?.sk && c.nostr.sk !== L.MARKER && L.store(L.ACCOUNTS.nostr, c.nostr.sk)) { c.nostr.sk = L.MARKER; moved.push("Nostr key"); }
  if (c.slack?.botToken && c.slack.botToken !== L.MARKER && L.store(L.ACCOUNTS.bot, c.slack.botToken)) { c.slack.botToken = L.MARKER; moved.push("bot token"); }
  return moved;
}

/** Takes them out of the keychain and puts them back in the file. So it can be undone. */
export function fromKeychain(c: Config): string[] {
  const restored: string[] = [];
  const pairs: [keyof typeof L.ACCOUNTS, (v: string) => void][] = [
    ["firma", v => { c.keys = { ...c.keys!, priv: v }; }],
    ["nostr", v => { c.nostr = { ...c.nostr, sk: v }; }],
    ["bot", v => { c.slack = { ...c.slack!, botToken: v }; }],
  ];
  for (const [account, put] of pairs) {
    const v = L.read(L.ACCOUNTS[account]);
    if (v) { put(v); L.remove(L.ACCOUNTS[account]); restored.push(account); }
  }
  return restored;
}

/** The token, wherever it comes from. Reading it from another tool's file instead of
 *  copying it avoids two copies to rotate separately. */
export function slackToken(c: Config): string | null {
  if (c.slack?.userToken) return c.slack.userToken;
  if (!c.slack?.tokenFile) return null;
  try {
    const j = JSON.parse(readFileSync(c.slack.tokenFile, "utf8"));
    const t = j[c.slack.tokenKey ?? "userToken"];
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}

/** The bot token, from the same file if needed. */
export function slackBotToken(c: Config): string | null {
  if (c.slack?.botToken) return c.slack.botToken;
  if (!c.slack?.tokenFile) return null;
  try {
    const t = JSON.parse(readFileSync(c.slack.tokenFile, "utf8"))[c.slack.botTokenKey ?? "botToken"];
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}

/** Contacts are stored under their name lowercased and without spaces, which is how it
 *  is typed after the @. */
export function contactByNpub(c: Config, pk: string): { id: string; name: string; pk?: string; npub?: string; relays?: string[] } | null {
  return Object.values(c.contacts ?? {}).find(x => x.npub === pk) ?? null;
}

export function addContact(c: Config, p: { id: string; name: string; pk?: string; npub?: string; relays?: string[] }) {
  // If they were already there under another name (or with a key), keep what was known.
  const prev = contactById(c, p.id);
  if (prev) {
    for (const [k, v] of Object.entries(c.contacts ?? {})) if (v.id === p.id) delete c.contacts![k];
  }
  // The name is set by the envelope's sender and is not signed: a new id calling itself
  // "Edu" cannot take over the real Edu's entry. It gets a suffix.
  let key = contactKey(p.name);
  const taken = c.contacts?.[key];
  if (taken && taken.id !== p.id) key = `${key}-${p.id.slice(-4).toLowerCase()}`;
  c.contacts = { ...(c.contacts ?? {}), [key]: { ...prev, ...p, pk: p.pk ?? prev?.pk, npub: p.npub ?? prev?.npub, relays: p.relays ?? prev?.relays } };
}

export function contactById(c: Config, id: string): { id: string; name: string; pk?: string } | null {
  return Object.values(c.contacts ?? {}).find(x => x.id === id) ?? null;
}

export const contactKey = (n: string) => n.toLowerCase().replace(/\s+/g, "");

export function contact(c: Config, needle: string): { id: string; name: string; pk?: string } | null {
  return c.contacts?.[contactKey(needle)] ?? null;
}

const LOCK = `${FILE}.lock`;
const LOCK_STALE_MS = 5000;

/** A file lock, short and with an expiry. If someone dies holding it, after 5 s it stops
 *  counting: a lock held forever would be worse than the race it prevents. */
function withLock<T>(fn: () => T): T {
  for (let i = 0; i < 100; i++) {
    try {
      closeSync(openSync(LOCK, "wx"));
      try { return fn(); } finally { try { unlinkSync(LOCK); } catch {} }
    } catch {
      try { if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  // No lock after two seconds: write anyway. Losing an update is bad; not saving the key
  // you just created is worse.
  return fn();
}

/**
 * Saves the config.
 *
 * Two processes do this at the same time all the time: the daemon records a contact on
 * every incoming message (`touchContact`) and pins keys, and the CLI writes in `join`,
 * `contacts`, `trust`, `rotate` and `forget`. Both do read-modify-save on the whole
 * file, so the last one to save erased whatever the other had done. Probe: A reads, B
 * reads, A adds Ana, B adds Bea, and at the end only Bea is there. So a freshly pinned
 * key, or your own keys just created by `join`, disappear without a word.
 *
 * Fixed in two steps. The lock keeps two writes from stepping on each other. And before
 * writing it checks whether the file changed since THIS process read it: whatever
 * appeared meanwhile in the contacts or the invites is kept. Comparing with what was
 * read, and not just with what is there, is what tells "I deleted this" apart from "I
 * never saw this": a `spoochie forget` still forgets.
 */
export function save(c: Config) {
  ensureDirs();
  // With an unreadable config nothing is written: it would turn "cannot read it" into "it does not exist".
  if (broken) { console.error("spoochie: not saving anything while config.json does not parse"); return; }
  withLock(() => {
    const onDisk = existsSync(FILE) ? readFileSync(FILE, "utf8") : null;
    if (onDisk !== null && onDisk !== lastRead) keepOthersChanges(c, onDisk);
    const text = JSON.stringify(mask(c), null, 2);
    // The backup of the previous one first, then the new one in one piece (`writeAtomic`).
    // The three keys and the contacts are in here: if something goes wrong, we want to be
    // able to go back, not just avoid ending up half written.
    try { if (existsSync(FILE)) renameSync(FILE, BACKUP); } catch {}
    writeAtomic(FILE, text);
    lastRead = text;
  });
}

/** What another process added while this one had its copy in hand. Only what was not
 *  there when we read: what was there and is gone now, we deleted it ourselves. */
function keepOthersChanges(c: Config, onDiskText: string) {
  let disk: any, read: any;
  try { disk = JSON.parse(onDiskText); } catch { return; }
  try { read = lastRead ? JSON.parse(lastRead) : {}; } catch { read = {}; }
  for (const map of ["contacts", "invitaciones"] as const) {
    const theirs = disk?.[map], seen = read?.[map] ?? {};
    if (!theirs || typeof theirs !== "object") continue;
    for (const k of Object.keys(theirs)) {
      if (k in seen) continue;                       // it was there: if it is missing, we removed it
      const mine = (c as any)[map] ?? ((c as any)[map] = {});
      if (!(k in mine)) mine[k] = theirs[k];
    }
  }
}

/** For tests: forget that the config was broken. */
export function forgetBroken() { broken = false; }

/**
 * Puts the marker back on the secrets that live in the keychain.
 *
 * Without this, the migration undid itself silently: `load` filled in the real secret,
 * any later `save` (and there is one in almost every operation) wrote it in the clear
 * again, and the keychain was just decoration. It is decided by asking the keychain, not
 * by remembering a state: if there is a key for that account there, the file gets the marker.
 */
export function mask(c: Config): Config {
  if (!L.available()) return c;
  const copy: Config = JSON.parse(JSON.stringify(c));
  if (copy.keys?.priv && L.read(L.ACCOUNTS.firma)) copy.keys.priv = L.MARKER;
  if (copy.nostr?.sk && L.read(L.ACCOUNTS.nostr)) copy.nostr.sk = L.MARKER;
  if (copy.slack?.botToken && L.read(L.ACCOUNTS.bot)) copy.slack.botToken = L.MARKER;
  return copy;
}

/**
 * Records that someone was heard from. Called on receiving an envelope from them, over
 * any transport.
 *
 * It is not live presence: there is no "are you there?" to send, and adding one would
 * mean touching the protocol to answer something the conversation itself already
 * answers. What is stored is a fact we already have: when their last one arrived.
 * `spoochie contacts` shows it, and with that you decide whether to open a tunnel now or
 * write on Slack.
 */
export function touchContact(sender: { id?: string; npub?: string }, now = Date.now()) {
  const c = load();
  const x = (sender.id ? contactById(c, sender.id) : null) ?? (sender.npub ? contactByNpub(c, sender.npub) : null);
  if (!x) return;
  (x as { visto?: number }).visto = now;
  save(c);
}
