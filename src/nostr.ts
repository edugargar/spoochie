/**
 * Nostr transport: no server of ours, end-to-end encrypted, deletable.
 *
 * Each person has a secp256k1 key pair (born at join). A spoochie message is a "rumor"
 * (kind 14, NIP-17) with the text in `content`, the subject in the `subject` tag (so a
 * Nostr client on a phone shows it readably) and the envelope data in the `sp` tag; it is
 * sealed with the sender's key (kind 13) and wrapped with a one-time key (kind 1059,
 * NIP-59) for the recipient. Relays only see "an envelope for this public key", with a
 * fake date.
 *
 * Each wrap's one-time key is kept in the thread: on close, it signs a deletion request
 * (kind 5, NIP-09) and the relays that honour it remove it. Whatever already reached the
 * other machine is deleted there by the close.
 *
 * Who can talk to me: only someone in my contacts with their key (the invite carries it).
 * An envelope from an unknown key is ignored without opening the tunnel.
 *
 * Relays are whichever each person picks; by default three public free ones. Writes go
 * to the recipient's relays and mine, reads come from mine.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip19, nip44, type Event, type EventTemplate } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as Cfg from "./config.ts";
import * as T from "./threads.ts";
import { PROTOCOL, readVersion } from "./protocol.ts";
import { ROOT, ensureDirs, writeAtomic } from "./paths.ts";
import { MAX_BYTES, SPOOL } from "./files.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const RUMOR = 14, SEAL = 13, WRAP = 1059, DELETION = 5;
/** NIP-59 fakes created_at up to two days back: subscriptions have to look from before that. */
const TWO_DAYS_S = 2 * 24 * 3600;

export type Keys = { sk: string; pk: string };

/** This person's keys; born the first time they are needed, and kept in the config at 0600. */
export function myKeys(c: Cfg.Config): Keys {
  if (c.nostr?.sk && c.nostr?.pk) return { sk: c.nostr.sk, pk: c.nostr.pk };
  const sk = generateSecretKey();
  const keys = { sk: bytesToHex(sk), pk: getPublicKey(sk) };
  c.nostr = { ...(c.nostr ?? {}), ...keys };
  return keys;
}
export const npub = (pk: string) => nip19.npubEncode(pk);
export function pkOf(npubOrHex: string): string | null {
  if (/^[0-9a-f]{64}$/.test(npubOrHex)) return npubOrHex;
  try { const d = nip19.decode(npubOrHex); return d.type === "npub" ? (d.data as string) : null; } catch { return null; }
}
export const myRelays = (c: Cfg.Config) => c.nostr?.relays?.length ? c.nostr.relays : DEFAULT_RELAYS;

/** What goes in the rumor's `sp` tag: the spoochie envelope. */
export type Envelope = {
  v: number;
  id: string;
  kind: "invite" | "msg" | "accept" | "close" | "notice" | "hola" | "file";
  app?: string;
  subject?: string;
  fromName?: string;
  context?: unknown;
  kindOfMsg?: T.MsgKind;
  /** In the join hello: my name, my Slack id if there is one, and my relays. */
  slack?: string;
  relays?: string[];
  /** In the join hello: the nonce of the invite being redeemed (keys.ts). */
  k?: string;
  /** A file chunk: which file, which chunk out of how many, and its name. */
  file?: { fid: string; n: number; total: number; name: string; size: number };
};

/**
 * Files (screenshots) travel in chunks, one envelope per chunk. NIP-44 sets the cap:
 * 65535 bytes of plaintext per layer, and there are two layers (seal inside wrap). 20 KB
 * raw is 27 KB in base64, ~38 KB of seal and ~55 KB of wrap: it fits in nos.lol (128 KB
 * per message) with room to spare. A 500 KB screenshot is 25 envelopes.
 */
export const CHUNK = 20 * 1024;
const VALID_FID = /^[A-Za-z0-9_-]{1,32}$/;
const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
const PARTS = ".partes";
const READY = ".listos.json";

const nowS = () => Math.floor(Date.now() / 1000);
const fakeDate = () => nowS() - Math.floor(Math.random() * TWO_DAYS_S);
const encrypt = (obj: unknown, sk: string, pk: string) => nip44.v2.encrypt(JSON.stringify(obj), nip44.v2.utils.getConversationKey(hexToBytes(sk), pk));
const decrypt = (ev: { content: string; pubkey: string }, sk: string) => JSON.parse(nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(hexToBytes(sk), ev.pubkey)));

/** Wraps a message for a recipient. Returns the wrap and the one-time key it was signed
 *  with, so its deletion can be requested later. */
export function wrapEnvelope(sk: string, toPk: string, envelope: Envelope, text: string): { wrap: Event; wsk: string } {
  const rumor = { kind: RUMOR, created_at: nowS(), pubkey: getPublicKey(hexToBytes(sk)), content: text,
    tags: [["p", toPk], ...(envelope.subject ? [["subject", envelope.subject]] : []), ["sp", JSON.stringify({ ...envelope, app: VERSION })]] };
  const seal = finalizeEvent({ kind: SEAL, created_at: fakeDate(), tags: [], content: encrypt(rumor, sk, toPk) } as EventTemplate, hexToBytes(sk));
  const wskBytes = generateSecretKey();
  const wrap = finalizeEvent({ kind: WRAP, created_at: fakeDate(), tags: [["p", toPk]], content: encrypt(seal, bytesToHex(wskBytes), toPk) } as EventTemplate, wskBytes);
  return { wrap, wsk: bytesToHex(wskBytes) };
}

export type Opened = { de: string; sobre: Envelope; texto: string; subject?: string };

/** Opens a wrap addressed to me. Null if it is not for me, not spoochie's, or malformed. */
export function open(wrap: Event, sk: string): Opened | null {
  try {
    if (wrap.kind !== WRAP) return null;
    const seal = decrypt(wrap, sk);
    if (seal.kind !== SEAL || !verifyEvent(seal)) return null;
    const rumor = decrypt(seal, sk);
    if (rumor.kind !== RUMOR || rumor.pubkey !== seal.pubkey) return null;
    const sp = rumor.tags.find((t: string[]) => t[0] === "sp")?.[1];
    if (!sp) return null;
    const envelope = JSON.parse(sp) as Envelope;
    // The version is NOT judged here. `open` decides whether the envelope is spoochie's
    // and well formed; what to do with a version I do not understand is decided by
    // `receive`, which can say so in the thread. This used to check `envelope.v !== 1`,
    // so a protocol 2 envelope (and one with no `v`, from before the field existed)
    // vanished without a trace while the other side saw it delivered. The rule written in
    // protocol.ts and published in docs/PROTOCOL.md says exactly the opposite, and over
    // Slack it did hold: the two paths did different things.
    if (envelope.v !== undefined && typeof envelope.v !== "number") return null;
    if (typeof envelope.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(envelope.id)) return null;
    return { de: seal.pubkey, sobre: envelope, texto: String(rumor.content ?? ""), subject: rumor.tags.find((t: string[]) => t[0] === "subject")?.[1] };
  } catch { return null; }
}

/** The deletion request for a wrap, signed with its one-time key. The content string is
 *  what 0.9.x has always published; it stays as is. */
export function deletionRequest(id: string, wsk: string): Event {
  return finalizeEvent({ kind: DELETION, created_at: nowS(), tags: [["e", id], ["k", String(WRAP)]], content: "spoochie cerrado" } as EventTemplate, hexToBytes(wsk));
}

/** The least of a pool that gets used, so tests can plug in a fake one. */
export type Pool = {
  publish(relays: string[], ev: Event): Promise<unknown>[];
  subscribe(relays: string[], filter: Record<string, unknown>, cb: { onevent(ev: Event): void; onclose?(reasons: string[]): void }): { close(): void };
  cerrar?(): void;
  /** Drops the connections and starts with fresh sockets. See `NostrBridge.refresh`. */
  reiniciar?(): void;
};

/** A pool over a shared directory: each publish is a file, each subscription reads it
 *  every 200 ms. With it, two real daemons are tested without touching any relay. */
export function filePool(dir: string): Pool {
  const { mkdirSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  return {
    publish(_relays, ev) {
      writeFileSync(join(dir, `${Date.now()}-${ev.id}.json`), JSON.stringify(ev));
      return [Promise.resolve()];
    },
    subscribe(_relays, filter, cb) {
      const p = (filter["#p"] as string[] | undefined) ?? [];
      const timer = setInterval(() => {
        for (const f of readdirSync(dir).sort()) {
          if (seen.has(f)) continue;
          seen.add(f);
          try {
            const ev = JSON.parse(readFileSync(join(dir, f), "utf8")) as Event;
            if (ev.kind === WRAP && p.includes(ev.tags.find(t => t[0] === "p")?.[1] ?? "")) cb.onevent(ev);
          } catch {}
        }
      }, 200);
      timer.unref();
      return { close: () => clearInterval(timer) };
    },
  };
}

export function realPool(): Pool {
  let pool = new SimplePool();
  return {
    publish: (relays, ev) => pool.publish(relays, ev),
    subscribe: (relays, filter, cb) => pool.subscribe(relays, filter as any, { onevent: cb.onevent, onclose: cb.onclose }),
    cerrar: () => pool.destroy(),
    reiniciar: () => { const old = pool; pool = new SimplePool(); try { old.destroy(); } catch {} },
  };
}

const SEEN_FILE = join(ROOT, "nostr-vistos.json");

export type Callbacks = {
  onMessage: (t: T.Thread, m: T.Msg) => Promise<void>;
  onRemoteAccept: (t: T.Thread, how: string) => Promise<void>;
  onCierre: (t: T.Thread, reason: string) => Promise<void>;
  /** Someone I invited is in now: they send me their key and relays. */
  onHola: (from: string, envelope: Envelope, name: string) => Promise<void>;
  /** An envelope from a key that is not in the contacts. See strangers.ts. */
  onDesconocido?: (from: string, envelope: Envelope) => Promise<void>;
  log: (...a: unknown[]) => void;
};

/** How often the connections are dropped and everything is asked for again. Whatever a
 *  relay did not send in that time arrives on the next round, because the filter asks for
 *  two days. */
export const REFRESH_MS = 5 * 60_000;

export class NostrBridge {
  private seen = new Set<string>();
  private subs = new Map<string, { close(): void }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private refreshMs: number;
  private publishWaitMs: number;
  constructor(readonly sk: string, readonly pk: string, readonly relays: string[], private cb: Callbacks, private pool: Pool = realPool(), opts: { refrescoMs?: number; esperaPublicarMs?: number } = {}) {
    this.refreshMs = opts.refrescoMs ?? REFRESH_MS;
    this.publishWaitMs = opts.esperaPublicarMs ?? 8000;
    try { if (existsSync(SEEN_FILE)) for (const id of JSON.parse(readFileSync(SEEN_FILE, "utf8"))) this.seen.add(id); } catch {}
  }

  static fromConfig(cb: Callbacks, pool?: Pool): NostrBridge | null {
    const c = Cfg.load();
    if (!c.nostr?.sk || !c.nostr?.pk) return null;
    return new NostrBridge(c.nostr.sk, c.nostr.pk, myRelays(c), cb, pool);
  }

  private saveSeen() {
    ensureDirs();
    try { writeAtomic(SEEN_FILE, JSON.stringify([...this.seen].slice(-5000))); } catch {}
  }

  /**
   * Listens for what arrives for me, with one subscription per relay.
   *
   * A single subscription to all three does not work: SimplePool (nostr-tools 2.25.2)
   * only fires onclose once ALL of them have closed, so a relay that dropped stayed
   * unheard forever as long as the others were alive. Measured on a real machine: a new
   * join's hello lived only on nos.lol and the daemon never saw it.
   *
   * And onclose is not enough even per relay: a half-dead socket, or a relay that forgets
   * the REQ, never closes. So every `refreshMs` the connections are dropped and
   * everything is asked for again; `seen` removes the repeats.
   */
  escuchar() {
    // A closed bridge does not listen again. Without this, `cerrar()` fired the relay's
    // onclose, and 5 s later the old bridge resubscribed next to the new one: two bridges
    // with two seen lists, and every envelope delivered twice to the session.
    if (this.closed) return;
    for (const url of this.relays) this.listenRelay(url);
    if (!this.timer) {
      this.timer = setInterval(() => this.refresh(), this.refreshMs);
      this.timer.unref?.();
    }
  }

  private listenRelay(url: string) {
    if (this.closed) return;
    this.subs.get(url)?.close();
    const filter = { kinds: [WRAP], "#p": [this.pk], since: nowS() - TWO_DAYS_S - 3600 };
    const mine = { close: () => {} };
    this.subs.set(url, mine);
    const sub = this.pool.subscribe([url], filter, {
      onevent: ev => { void this.receive(ev); },
      // Only retries the current subscription: closing an old one on refresh also fires
      // its onclose, and without this check every refresh duplicated the relay.
      onclose: () => { if (!this.closed && this.subs.get(url) === mine) setTimeout(() => { if (this.subs.get(url) === mine) this.listenRelay(url); }, 5000).unref?.(); },
    });
    mine.close = () => sub.close();
  }

  private refresh() {
    if (this.closed) return;
    const old = [...this.subs.values()];
    this.subs.clear();
    for (const s of old) { try { s.close(); } catch {} }
    this.pool.reiniciar?.();
    for (const url of this.relays) this.listenRelay(url);
  }

  cerrar() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const s of this.subs.values()) { try { s.close(); } catch {} }
    this.subs.clear();
    this.pool.cerrar?.();
  }

  private async receive(ev: Event) {
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    this.saveSeen();
    const a = open(ev, this.sk);
    if (!a) return;
    const c = Cfg.load();
    const contact = Cfg.contactByNpub(c, a.de);
    if (a.sobre.kind === "hola") {
      await this.cb.onHola(a.de, a.sobre, a.sobre.fromName ?? a.texto);
      return;
    }
    // Someone not in the contacts does not even get to make me write in a thread: the
    // version is checked afterwards, because the "update" notice gets posted and anyone
    // who can encrypt to my key could trigger it.
    if (!contact) {
      this.cb.log("nostr", "envelope from a key not in the contacts; ignored", a.de.slice(0, 12), a.sobre.kind);
      if (a.sobre.kind === "invite") await this.answerStranger(a, c);
      await this.cb.onDesconocido?.(a.de, a.sobre);
      return;
    }
    // If I do not understand the envelope I cannot treat it as if I did: it would lack
    // exactly the part that narrows it or the part that holds it back. Say so, do not deliver.
    const reading = readVersion(a.sobre.v, a.sobre.app);
    if (!reading.entiendo) {
      this.cb.log("nostr", a.sobre.id, `envelope not delivered: ${reading.por}`);
      // If it is an invite there is no thread to say it in yet, and over Nostr there is
      // nowhere else: it stays in the daemon log and `spoochie doctor` surfaces it.
      const t0 = T.load(a.sobre.id);
      if (t0) await this.cb.onMessage(t0, { at: Date.now(), from: t0.from.sessionId === `nostr:${a.de}` ? t0.from.sessionId : t0.to.sessionId, author: "claude", kind: "text", text: `[spoochie] A message from the other machine was not delivered: ${reading.por}`, firma: "ok" });
      return;
    }
    Cfg.touchContact({ npub: a.de });
    if (a.sobre.kind === "invite") { await this.materialize(a, contact); return; }
    if (a.sobre.kind === "file") { await this.chunk(a); return; }
    const t = T.load(a.sobre.id);
    if (!t || t.transporte !== "nostr" || t.nostr?.otro !== a.de) return;
    // An envelope arriving after close (relays do not keep order) does not bring the
    // thread back: it is already purged, and putting a message back in breaks "deleted on close".
    if (t.state === "closed") { this.cb.log("nostr", t.id, "envelope after close; dropped"); return; }
    if (a.sobre.kind === "accept") { await this.cb.onRemoteAccept(t, "on the other machine"); return; }
    if (a.sobre.kind === "close") { await this.cb.onCierre(t, a.texto || "closed by the other side"); return; }
    if (a.sobre.kind === "notice") return;
    await this.cb.onMessage(t, { at: Date.now(), from: t.from.sessionId === `nostr:${a.de}` ? t.from.sessionId : t.to.sessionId, author: "claude", kind: a.sobre.kindOfMsg ?? "text", text: a.texto, firma: "ok" });
  }

  /**
   * An invite from a key that is not in my contacts is answered by closing it.
   *
   * It used to be dropped silently, and the other side stayed on "delivered, pending"
   * waiting for an answer that was never coming: on 14-09, with a real join, neither
   * person found out anything. A `close` to that id is understood by every version since
   * 0.9; it closes their spoochie and their Claude tells them why.
   *
   * Fixed text, nothing from what they sent: I do not echo what comes from outside. And
   * at most once a day per key and twenty per hour overall, because answering anyone who
   * can encrypt to my key is lending them my daemon.
   */
  private rejected = new Map<string, number>();
  private async answerStranger(a: Opened, c: Cfg.Config) {
    const nowMs = Date.now();
    const last = this.rejected.get(a.de);
    if (last !== undefined && nowMs - last < 24 * 3600_000) return;
    const inLastHour = [...this.rejected.values()].filter(x => nowMs - x < 3600_000).length;
    if (inLastHour >= 20) return;
    this.rejected.set(a.de, nowMs);
    const who = (c.human ?? "").replace(/[\[\]\r\n\t]/g, "").trim().slice(0, 30) || "The person you called";
    const text = `${who} does not have you in their spoochie contacts, so it did not arrive. Ask to be invited`;
    const { wrap } = wrapEnvelope(this.sk, a.de, { v: PROTOCOL, id: a.sobre.id, kind: "close" }, text);
    try { await Promise.any(this.pool.publish(this.relays, wrap)); this.cb.log("nostr", a.sobre.id, "answered: not in the contacts", a.de.slice(0, 12)); }
    catch (e) { this.cb.log("nostr", a.sobre.id, "could not answer the stranger", String(e)); }
  }

  /** A spoochie arriving from another machine: it stays pending until my human accepts. */
  private async materialize(a: Opened, contact: { id: string; name: string; relays?: string[] }) {
    if (T.load(a.sobre.id) || T.alreadySeen(a.sobre.id)) return;
    // A contact does not fill your state with spoochies you have not answered: see
    // `roomForAnotherFrom`. The existing ones expire on their own after 4 h.
    if (!T.roomForAnotherFrom(`nostr:${a.de}`)) {
      this.cb.log("nostr", a.sobre.id, `${contact.name} already has ${T.MAX_PENDING_PER_PERSON} unanswered spoochies with you; this one does not get in`);
      return;
    }
    const now = Date.now();
    const name = T.displayName(contact.name, a.sobre.fromName, contact.id);
    const t: T.Thread = {
      id: a.sobre.id,
      subject: T.outsideSubject(a.sobre.subject ?? a.subject),
      // The name comes from the contacts, not from the envelope: see `displayName`.
      from: { sessionId: `nostr:${a.de}`, name, cwd: "(otra maquina)", human: name, slackUser: contact.id.startsWith("nostr:") ? undefined : contact.id },
      to: { sessionId: `nostr:${this.pk}`, name: "yo", cwd: "(esta maquina)", slackUser: Cfg.load().slack?.userId },
      state: "pending", createdAt: now, lastActivityAt: now,
      context: T.outsideContext(a.sobre.context),
      transporte: "nostr",
      nostr: { otro: a.de, relays: a.sobre.relays ?? contact.relays ?? DEFAULT_RELAYS, enviados: [] },
      messages: [],
    };
    T.save(t);
    await this.cb.onMessage(t, { at: now, from: t.from.sessionId, author: "claude", kind: "text", text: a.texto || "(the opening message arrived empty)", firma: "ok" });
    await this.deliverReady(t);
  }

  /**
   * A file chunk. It is stored in the thread's spool; with the last one the file is put
   * back together and announced with its local path, like the Slack bridge does. Relays
   * do not guarantee order: chunks can arrive before the invite, and then the file waits
   * in the spool until the thread exists.
   */
  private async chunk(a: Opened) {
    const f = a.sobre.file;
    if (!f || !VALID_FID.test(String(f.fid)) || !Number.isInteger(f.n) || !Number.isInteger(f.total) || f.n < 0 || f.n >= f.total) return;
    if (f.total > Math.ceil(MAX_BYTES / CHUNK) || !(f.size >= 0 && f.size <= MAX_BYTES)) { this.cb.log("nostr", "file too big; ignored", f.name); return; }
    // The numbers above are declared by the sender; these are the bytes that actually
    // arrive. Without this line a single envelope carried a chunk as big as the relay
    // allowed: measured, 3 MB written to disk with CHUNK at 20 KB, and decoded whole in
    // memory before anyone checked anything. A chunk bigger than a chunk is not a
    // spoochie chunk.
    const raw = Buffer.from(a.texto, "base64");
    if (raw.length > CHUNK) { this.cb.log("nostr", "chunk bigger than a chunk; ignored", f.name, raw.length); return; }
    const t = T.load(a.sobre.id);
    if (t && (t.transporte !== "nostr" || t.nostr?.otro !== a.de || t.state === "closed")) return;
    if (!t && T.alreadySeen(a.sobre.id)) return;
    const dir = join(SPOOL, a.sobre.id, PARTS, f.fid);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, String(f.n)), raw, { mode: 0o600 });
    const have = readdirSync(dir).filter(x => /^\d+$/.test(x)).length;
    if (have < f.total) return;
    const parts: Buffer[] = [];
    for (let i = 0; i < f.total; i++) parts.push(readFileSync(join(dir, String(i))));
    const bytes = Buffer.concat(parts);
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(join(SPOOL, a.sobre.id, PARTS)); } catch {}
    if (bytes.length !== f.size) { this.cb.log("nostr", "file rebuilt with a different size; dropped", f.name); return; }
    const dest = join(SPOOL, a.sobre.id, `${f.fid}-${safeName(f.name)}`);
    writeFileSync(dest, bytes, { mode: 0o600 });
    const ready = join(SPOOL, a.sobre.id, READY);
    const queue: string[] = existsSync(ready) ? JSON.parse(readFileSync(ready, "utf8")) : [];
    writeAtomic(ready, JSON.stringify([...queue, dest]));
    if (t) await this.deliverReady(t);
  }

  private async deliverReady(t: T.Thread) {
    const ready = join(SPOOL, t.id, READY);
    if (!existsSync(ready)) return;
    const paths: string[] = JSON.parse(readFileSync(ready, "utf8"));
    rmSync(ready, { force: true });
    if (!paths.length) return;
    await this.cb.onMessage(t, {
      at: Date.now(), from: t.from.sessionId === `nostr:${t.nostr?.otro}` ? t.from.sessionId : t.to.sessionId, author: "claude", kind: "text",
      text: `I'm leaving you ${paths.length === 1 ? "a file" : `${paths.length} files`} through the tunnel. They are already on this machine, open them if you like.`,
      files: paths, firma: "ok",
    });
  }

  /** Sends a turn's files, in chunks. Files that do not fit or do not exist are skipped. */
  private async sendFiles(t: T.Thread, paths: string[] | undefined): Promise<void> {
    for (const path of paths ?? []) {
      let bytes: Buffer;
      try { if (statSync(path).size > MAX_BYTES) { this.cb.log("nostr", "file over 10 MB; not sent", path); continue; } bytes = readFileSync(path); } catch { continue; }
      const fid = Math.random().toString(36).slice(2, 10);
      const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
      for (let n = 0; n < total; n++) {
        const ok = await this.send(t, { v: PROTOCOL, id: t.id, kind: "file", file: { fid, n, total, name: basename(path), size: bytes.length } }, bytes.subarray(n * CHUNK, (n + 1) * CHUNK).toString("base64"));
        if (!ok) { this.cb.log("nostr", "file half sent, a chunk was not published", path); break; }
      }
    }
  }

  private async send(t: T.Thread, envelope: Envelope, text: string): Promise<boolean> {
    if (!t.nostr) return false;
    const { wrap, wsk } = wrapEnvelope(this.sk, t.nostr.otro, envelope, text);
    const relays = [...new Set([...t.nostr.relays, ...this.relays])];
    try {
      await Promise.any(this.pool.publish(relays, wrap));
    } catch (e) { this.cb.log("nostr", "could not publish to any relay", String(e)); return false; }
    const fresh = T.load(t.id) ?? t;
    fresh.nostr = { ...(fresh.nostr ?? t.nostr), enviados: [...(fresh.nostr?.enviados ?? []), { id: wrap.id, wsk }] };
    T.save(fresh);
    return true;
  }

  /** Opens a spoochie to another machine: the invite is the first envelope. */
  async openThread(t: T.Thread, otherPk: string, relays: string[]): Promise<boolean> {
    t.transporte = "nostr";
    t.nostr = { otro: otherPk, relays: relays.length ? relays : DEFAULT_RELAYS, enviados: [] };
    const ok = await this.send(t, { v: PROTOCOL, id: t.id, kind: "invite", subject: t.subject, fromName: t.from.human ?? t.from.name, context: t.context, relays: this.relays }, t.messages[0]?.text ?? "");
    if (ok) await this.sendFiles(T.load(t.id) ?? t, t.messages[0]?.files);
    return ok;
  }

  async post(t: T.Thread, notice: string, m?: T.Msg): Promise<boolean> {
    // The accept and close notices are recognised by their text, which threads.ts writes
    // (renderAccepted, renderClose). They still carry the Spanish markers; the English
    // ones are accepted too, as in slack.ts, so the renderers can switch without this file.
    const accepted = notice.includes("ha aceptado el tunel") || notice.includes("accepted the tunnel");
    const closed = notice.includes("cerrado (") || notice.includes("closed (");
    const kind: Envelope["kind"] = m ? "msg" : accepted ? "accept" : closed ? "close" : "notice";
    const text = m ? m.text : kind === "close" ? (t.closeReason ?? "closed") : notice;
    // Files go before the text, so the other side has them when reading it.
    if (m?.files?.length) await this.sendFiles(t, m.files);
    return this.send(T.load(t.id) ?? t, { v: PROTOCOL, id: t.id, kind, subject: t.subject, ...(m ? { kindOfMsg: m.kind } : {}) }, text);
  }

  async aviso(t: T.Thread, text: string) { await this.send(t, { v: PROTOCOL, id: t.id, kind: "notice", subject: t.subject }, text); }
  async pensandoOn(_t: T.Thread, _who: string) {}
  async pensandoOff(_t: T.Thread) {}

  /** Asks the relays to delete everything this side sent for this spoochie. */
  async borrarHilo(t: T.Thread): Promise<number> {
    let n = 0;
    for (const e of t.nostr?.enviados ?? []) {
      try { await Promise.any(this.pool.publish([...new Set([...t.nostr!.relays, ...this.relays])], deletionRequest(e.id, e.wsk))); n++; } catch {}
    }
    return n;
  }

  /**
   * The join hello: I tell whoever invited me who I am.
   *
   * Waits for every relay, not the first. The caller is `join`, which closes the pool as
   * soon as it returns, and with Promise.any the other publishes got cut off: measured on
   * 14-09, a real join's hello ended up on one relay out of three. A relay that does not
   * answer does not hang the join: after `publishWaitMs` it stops waiting.
   */
  async hola(toPk: string, relays: string[], name: string, slackId?: string, k?: string): Promise<boolean> {
    const { wrap } = wrapEnvelope(this.sk, toPk, { v: PROTOCOL, id: "hola", kind: "hola", fromName: name, slack: slackId, relays: this.relays, k }, `${name} is on spoochie now`);
    let accepted = 0;
    const all = this.pool.publish([...new Set([...relays, ...this.relays])], wrap).map(p => p.then(() => { accepted++; }, () => {}));
    await Promise.race([Promise.all(all), new Promise(r => setTimeout(r, this.publishWaitMs).unref?.())]);
    return accepted > 0;
  }
}
