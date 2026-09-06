/**
 * Transporte Nostr: sin servidor nuestro, cifrado de extremo a extremo, borrable.
 *
 * Cada persona tiene un par de claves secp256k1 (nace en el alta). Un mensaje de
 * spoochie es un "rumor" (kind 14, NIP-17) con el texto en `content`, el asunto en la
 * etiqueta `subject` (asi un cliente Nostr del movil lo ensena legible) y los datos
 * del sobre en la etiqueta `sp`; va sellado con la clave del emisor (kind 13) y
 * envuelto con una clave de un solo uso (kind 1059, NIP-59) para el receptor. Los
 * reles solo ven "un sobre para esta clave publica", con fecha falseada.
 *
 * La clave de un solo uso de cada envoltura se guarda en el hilo: al cerrar, se firma
 * con ella una peticion de borrado (kind 5, NIP-09) y los reles que la honran lo
 * quitan. Lo que ya llego a la otra maquina se borra alli por el cierre.
 *
 * Quien puede hablarme: solo quien esta en mi agenda con su clave (la invitacion la
 * lleva). Un sobre de una clave desconocida se ignora sin abrir el tunel.
 *
 * Los reles son los que cada persona elija; por defecto tres publicos y gratuitos.
 * Se escribe en los del receptor y en los mios, y se lee de los mios.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip19, nip44, type Event, type EventTemplate } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as Cfg from "./config.ts";
import * as T from "./threads.ts";
import { ROOT, ensureDirs } from "./paths.ts";
import { MAX_BYTES, SPOOL } from "./files.ts";
import { VERSION } from "./version.ts";

export const RELAYS_POR_DEFECTO = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const RUMOR = 14, SELLO = 13, ENVOLTURA = 1059, BORRADO = 5;
/** NIP-59 falsea created_at hasta dos dias atras: al suscribirse hay que mirar desde antes. */
const DOS_DIAS_S = 2 * 24 * 3600;

export type Claves = { sk: string; pk: string };

/** Las claves de esta persona; nacen la primera vez que hacen falta y van en la config a 0600. */
export function misClaves(c: Cfg.Config): Claves {
  if (c.nostr?.sk && c.nostr?.pk) return { sk: c.nostr.sk, pk: c.nostr.pk };
  const sk = generateSecretKey();
  const claves = { sk: bytesToHex(sk), pk: getPublicKey(sk) };
  c.nostr = { ...(c.nostr ?? {}), ...claves };
  return claves;
}
export const npub = (pk: string) => nip19.npubEncode(pk);
export function pkDe(npubOHex: string): string | null {
  if (/^[0-9a-f]{64}$/.test(npubOHex)) return npubOHex;
  try { const d = nip19.decode(npubOHex); return d.type === "npub" ? (d.data as string) : null; } catch { return null; }
}
export const misReles = (c: Cfg.Config) => c.nostr?.relays?.length ? c.nostr.relays : RELAYS_POR_DEFECTO;

/** Lo que va en la etiqueta `sp` del rumor: el sobre de spoochie. */
export type Sobre = {
  v: 1;
  id: string;
  kind: "invite" | "msg" | "accept" | "close" | "notice" | "hola" | "file";
  app?: string;
  subject?: string;
  fromName?: string;
  context?: unknown;
  kindOfMsg?: T.MsgKind;
  /** En el hola del alta: mi nombre, mi id de Slack si lo hay, y mis reles. */
  slack?: string;
  relays?: string[];
  /** Un trozo de fichero: cual, que trozo de cuantos, y como se llama. */
  file?: { fid: string; n: number; total: number; name: string; size: number };
};

/**
 * Los ficheros (capturas) van en trozos, cada trozo un sobre. El tope lo pone NIP-44:
 * 65535 bytes de texto en claro por capa, y hay dos capas (sello dentro de envoltura).
 * 20 KB crudos son 27 KB en base64, ~38 KB de sello y ~55 KB de envoltura: cabe en
 * nos.lol (128 KB por mensaje) con margen. Una captura de 500 KB son 25 sobres.
 */
export const TROZO = 20 * 1024;
const FID_VALIDO = /^[A-Za-z0-9_-]{1,32}$/;
const nombreSeguro = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "fichero";
const PARTES = ".partes";
const LISTOS = ".listos.json";

const ahora = () => Math.floor(Date.now() / 1000);
const fechaFalsa = () => ahora() - Math.floor(Math.random() * DOS_DIAS_S);
const cifrar = (obj: unknown, sk: string, pk: string) => nip44.v2.encrypt(JSON.stringify(obj), nip44.v2.utils.getConversationKey(hexToBytes(sk), pk));
const descifrar = (ev: { content: string; pubkey: string }, sk: string) => JSON.parse(nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(hexToBytes(sk), ev.pubkey)));

/** Envuelve un mensaje para un receptor. Devuelve la envoltura y la clave de un solo uso
 *  con la que se firmo, para poder pedir su borrado despues. */
export function envolver(sk: string, paraPk: string, sobre: Sobre, texto: string): { wrap: Event; wsk: string } {
  const rumor = { kind: RUMOR, created_at: ahora(), pubkey: getPublicKey(hexToBytes(sk)), content: texto,
    tags: [["p", paraPk], ...(sobre.subject ? [["subject", sobre.subject]] : []), ["sp", JSON.stringify({ ...sobre, app: VERSION })]] };
  const sello = finalizeEvent({ kind: SELLO, created_at: fechaFalsa(), tags: [], content: cifrar(rumor, sk, paraPk) } as EventTemplate, hexToBytes(sk));
  const wskBytes = generateSecretKey();
  const wrap = finalizeEvent({ kind: ENVOLTURA, created_at: fechaFalsa(), tags: [["p", paraPk]], content: cifrar(sello, bytesToHex(wskBytes), paraPk) } as EventTemplate, wskBytes);
  return { wrap, wsk: bytesToHex(wskBytes) };
}

export type Abierto = { de: string; sobre: Sobre; texto: string; subject?: string };

/** Abre una envoltura dirigida a mi. Null si no es para mi, no es de spoochie o esta mal. */
export function abrir(wrap: Event, sk: string): Abierto | null {
  try {
    if (wrap.kind !== ENVOLTURA) return null;
    const sello = descifrar(wrap, sk);
    if (sello.kind !== SELLO || !verifyEvent(sello)) return null;
    const rumor = descifrar(sello, sk);
    if (rumor.kind !== RUMOR || rumor.pubkey !== sello.pubkey) return null;
    const sp = rumor.tags.find((t: string[]) => t[0] === "sp")?.[1];
    if (!sp) return null;
    const sobre = JSON.parse(sp) as Sobre;
    if (sobre.v !== 1 || typeof sobre.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(sobre.id)) return null;
    return { de: sello.pubkey, sobre, texto: String(rumor.content ?? ""), subject: rumor.tags.find((t: string[]) => t[0] === "subject")?.[1] };
  } catch { return null; }
}

/** La peticion de borrado de una envoltura, firmada con su clave de un solo uso. */
export function peticionBorrado(id: string, wsk: string): Event {
  return finalizeEvent({ kind: BORRADO, created_at: ahora(), tags: [["e", id], ["k", String(ENVOLTURA)]], content: "spoochie cerrado" } as EventTemplate, hexToBytes(wsk));
}

/** Lo minimo que se usa de un pool, para poder poner uno falso en los tests. */
export type Pool = {
  publish(relays: string[], ev: Event): Promise<unknown>[];
  subscribe(relays: string[], filtro: Record<string, unknown>, cb: { onevent(ev: Event): void; onclose?(razones: string[]): void }): { close(): void };
  cerrar?(): void;
};

/** Un pool sobre un directorio compartido: cada publish es un fichero, cada suscripcion
 *  lo lee cada 200 ms. Con el se prueban dos demonios de verdad sin tocar ningun rele. */
export function poolDeFichero(dir: string): Pool {
  const { mkdirSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true });
  const vistos = new Set<string>();
  return {
    publish(_relays, ev) {
      writeFileSync(join(dir, `${Date.now()}-${ev.id}.json`), JSON.stringify(ev));
      return [Promise.resolve()];
    },
    subscribe(_relays, filtro, cb) {
      const p = (filtro["#p"] as string[] | undefined) ?? [];
      const timer = setInterval(() => {
        for (const f of readdirSync(dir).sort()) {
          if (vistos.has(f)) continue;
          vistos.add(f);
          try {
            const ev = JSON.parse(readFileSync(join(dir, f), "utf8")) as Event;
            if (ev.kind === ENVOLTURA && p.includes(ev.tags.find(t => t[0] === "p")?.[1] ?? "")) cb.onevent(ev);
          } catch {}
        }
      }, 200);
      timer.unref();
      return { close: () => clearInterval(timer) };
    },
  };
}

export function poolReal(): Pool {
  const pool = new SimplePool();
  return {
    publish: (relays, ev) => pool.publish(relays, ev),
    subscribe: (relays, filtro, cb) => pool.subscribe(relays, filtro as any, { onevent: cb.onevent, onclose: cb.onclose }),
    cerrar: () => pool.destroy(),
  };
}

const VISTOS = join(ROOT, "nostr-vistos.json");

export type Callbacks = {
  onMessage: (t: T.Thread, m: T.Msg) => Promise<void>;
  onRemoteAccept: (t: T.Thread, como: string) => Promise<void>;
  onCierre: (t: T.Thread, motivo: string) => Promise<void>;
  /** Alguien a quien invite ya esta dentro: me manda su clave y sus reles. */
  onHola: (de: string, sobre: Sobre, nombre: string) => Promise<void>;
  log: (...a: unknown[]) => void;
};

export class NostrBridge {
  private vistos = new Set<string>();
  private sub: { close(): void } | null = null;
  constructor(readonly sk: string, readonly pk: string, readonly relays: string[], private cb: Callbacks, private pool: Pool = poolReal()) {
    try { if (existsSync(VISTOS)) for (const id of JSON.parse(readFileSync(VISTOS, "utf8"))) this.vistos.add(id); } catch {}
  }

  static fromConfig(cb: Callbacks, pool?: Pool): NostrBridge | null {
    const c = Cfg.load();
    if (!c.nostr?.sk || !c.nostr?.pk) return null;
    return new NostrBridge(c.nostr.sk, c.nostr.pk, misReles(c), cb, pool);
  }

  private guardarVistos() {
    ensureDirs();
    try { writeFileSync(VISTOS, JSON.stringify([...this.vistos].slice(-5000)), { mode: 0o600 }); } catch {}
  }

  /** Escucha lo que llega para mi. Se vuelve a suscribir sola si el rele corta. */
  escuchar() {
    const filtro = { kinds: [ENVOLTURA], "#p": [this.pk], since: ahora() - DOS_DIAS_S - 3600 };
    this.sub = this.pool.subscribe(this.relays, filtro, {
      onevent: ev => { void this.recibir(ev); },
      onclose: () => { setTimeout(() => this.escuchar(), 5000).unref?.(); },
    });
  }

  cerrar() { this.sub?.close(); this.pool.cerrar?.(); }

  private async recibir(ev: Event) {
    if (this.vistos.has(ev.id)) return;
    this.vistos.add(ev.id);
    this.guardarVistos();
    const a = abrir(ev, this.sk);
    if (!a) return;
    const c = Cfg.load();
    const contacto = Cfg.contactoPorNpub(c, a.de);
    if (a.sobre.kind === "hola") {
      await this.cb.onHola(a.de, a.sobre, a.sobre.fromName ?? a.texto);
      return;
    }
    if (!contacto) { this.cb.log("nostr", "sobre de una clave que no esta en la agenda; ignorado", a.de.slice(0, 12)); return; }
    if (a.sobre.kind === "invite") { await this.materializar(a, contacto); return; }
    if (a.sobre.kind === "file") { await this.trozo(a); return; }
    const t = T.load(a.sobre.id);
    if (!t || t.transporte !== "nostr" || t.nostr?.otro !== a.de) return;
    // Un sobre que llega despues de cerrar (los reles no ordenan) no resucita el hilo:
    // ya esta purgado, y volver a meterle un mensaje rompe el "borrado al cerrar".
    if (t.state === "closed") { this.cb.log("nostr", t.id, "sobre tras cerrar; descartado"); return; }
    if (a.sobre.kind === "accept") { await this.cb.onRemoteAccept(t, "en la otra maquina"); return; }
    if (a.sobre.kind === "close") { await this.cb.onCierre(t, a.texto || "cerrado por el otro lado"); return; }
    if (a.sobre.kind === "notice") return;
    await this.cb.onMessage(t, { at: Date.now(), from: t.from.sessionId === `nostr:${a.de}` ? t.from.sessionId : t.to.sessionId, author: "claude", kind: a.sobre.kindOfMsg ?? "text", text: a.texto, firma: "ok" });
  }

  /** Un spoochie que me llega de otra maquina: queda pendiente hasta que mi humano acepte. */
  private async materializar(a: Abierto, contacto: { id: string; name: string; relays?: string[] }) {
    if (T.load(a.sobre.id) || T.yaVisto(a.sobre.id)) return;
    const now = Date.now();
    const t: T.Thread = {
      id: a.sobre.id,
      subject: a.sobre.subject ?? a.subject ?? "(sin asunto)",
      from: { sessionId: `nostr:${a.de}`, name: a.sobre.fromName ?? contacto.name, cwd: "(otra maquina)", human: a.sobre.fromName ?? contacto.name, slackUser: contacto.id.startsWith("nostr:") ? undefined : contacto.id },
      to: { sessionId: `nostr:${this.pk}`, name: "yo", cwd: "(esta maquina)", slackUser: Cfg.load().slack?.userId },
      state: "pending", createdAt: now, lastActivityAt: now,
      context: (a.sobre.context as T.Thread["context"]) ?? {},
      transporte: "nostr",
      nostr: { otro: a.de, relays: a.sobre.relays ?? contacto.relays ?? RELAYS_POR_DEFECTO, enviados: [] },
      messages: [],
    };
    T.save(t);
    await this.cb.onMessage(t, { at: now, from: t.from.sessionId, author: "claude", kind: "text", text: a.texto || "(el mensaje de apertura llego vacio)", firma: "ok" });
    await this.entregarListos(t);
  }

  /**
   * Un trozo de fichero. Se guarda en el spool del hilo; con el ultimo se recompone el
   * fichero y se anuncia con su ruta local, como hace el puente de Slack. Los reles no
   * garantizan el orden: los trozos pueden llegar antes que la invitacion, y entonces
   * el fichero espera en el spool hasta que el hilo exista.
   */
  private async trozo(a: Abierto) {
    const f = a.sobre.file;
    if (!f || !FID_VALIDO.test(String(f.fid)) || !Number.isInteger(f.n) || !Number.isInteger(f.total) || f.n < 0 || f.n >= f.total) return;
    if (f.total > Math.ceil(MAX_BYTES / TROZO) || !(f.size >= 0 && f.size <= MAX_BYTES)) { this.cb.log("nostr", "fichero demasiado grande; ignorado", f.name); return; }
    const t = T.load(a.sobre.id);
    if (t && (t.transporte !== "nostr" || t.nostr?.otro !== a.de || t.state === "closed")) return;
    if (!t && T.yaVisto(a.sobre.id)) return;
    const dir = join(SPOOL, a.sobre.id, PARTES, f.fid);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, String(f.n)), Buffer.from(a.texto, "base64"), { mode: 0o600 });
    const tengo = readdirSync(dir).filter(x => /^\d+$/.test(x)).length;
    if (tengo < f.total) return;
    const partes: Buffer[] = [];
    for (let i = 0; i < f.total; i++) partes.push(readFileSync(join(dir, String(i))));
    const bytes = Buffer.concat(partes);
    rmSync(dir, { recursive: true, force: true });
    try { rmdirSync(join(SPOOL, a.sobre.id, PARTES)); } catch {}
    if (bytes.length !== f.size) { this.cb.log("nostr", "fichero recompuesto con otro tamano; descartado", f.name); return; }
    const destino = join(SPOOL, a.sobre.id, `${f.fid}-${nombreSeguro(f.name)}`);
    writeFileSync(destino, bytes, { mode: 0o600 });
    const listos = join(SPOOL, a.sobre.id, LISTOS);
    const cola: string[] = existsSync(listos) ? JSON.parse(readFileSync(listos, "utf8")) : [];
    writeFileSync(listos, JSON.stringify([...cola, destino]), { mode: 0o600 });
    if (t) await this.entregarListos(t);
  }

  private async entregarListos(t: T.Thread) {
    const listos = join(SPOOL, t.id, LISTOS);
    if (!existsSync(listos)) return;
    const rutas: string[] = JSON.parse(readFileSync(listos, "utf8"));
    rmSync(listos, { force: true });
    if (!rutas.length) return;
    await this.cb.onMessage(t, {
      at: Date.now(), from: t.from.sessionId === `nostr:${t.nostr?.otro}` ? t.from.sessionId : t.to.sessionId, author: "claude", kind: "text",
      text: `Te dejo ${rutas.length === 1 ? "un fichero" : `${rutas.length} ficheros`} por el tunel. Ya estan en esta maquina, abrelos si quieres.`,
      files: rutas, firma: "ok",
    });
  }

  /** Manda los ficheros de un turno, a trozos. Los que no caben o no existen se saltan. */
  private async enviarFicheros(t: T.Thread, rutas: string[] | undefined): Promise<void> {
    for (const ruta of rutas ?? []) {
      let bytes: Buffer;
      try { if (statSync(ruta).size > MAX_BYTES) { this.cb.log("nostr", "fichero de mas de 10 MB; no se manda", ruta); continue; } bytes = readFileSync(ruta); } catch { continue; }
      const fid = Math.random().toString(36).slice(2, 10);
      const total = Math.max(1, Math.ceil(bytes.length / TROZO));
      for (let n = 0; n < total; n++) {
        const ok = await this.enviar(t, { v: 1, id: t.id, kind: "file", file: { fid, n, total, name: basename(ruta), size: bytes.length } }, bytes.subarray(n * TROZO, (n + 1) * TROZO).toString("base64"));
        if (!ok) { this.cb.log("nostr", "fichero a medias, un trozo no se publico", ruta); break; }
      }
    }
  }

  private async enviar(t: T.Thread, sobre: Sobre, texto: string): Promise<boolean> {
    if (!t.nostr) return false;
    const { wrap, wsk } = envolver(this.sk, t.nostr.otro, sobre, texto);
    const reles = [...new Set([...t.nostr.relays, ...this.relays])];
    try {
      await Promise.any(this.pool.publish(reles, wrap));
    } catch (e) { this.cb.log("nostr", "no se pudo publicar en ningun rele", String(e)); return false; }
    const fresco = T.load(t.id) ?? t;
    fresco.nostr = { ...(fresco.nostr ?? t.nostr), enviados: [...(fresco.nostr?.enviados ?? []), { id: wrap.id, wsk }] };
    T.save(fresco);
    return true;
  }

  /** Abre un spoochie hacia otra maquina: la invitacion es el primer sobre. */
  async openThread(t: T.Thread, otroPk: string, relays: string[]): Promise<boolean> {
    t.transporte = "nostr";
    t.nostr = { otro: otroPk, relays: relays.length ? relays : RELAYS_POR_DEFECTO, enviados: [] };
    const ok = await this.enviar(t, { v: 1, id: t.id, kind: "invite", subject: t.subject, fromName: t.from.human ?? t.from.name, context: t.context, relays: this.relays }, t.messages[0]?.text ?? "");
    if (ok) await this.enviarFicheros(T.load(t.id) ?? t, t.messages[0]?.files);
    return ok;
  }

  async post(t: T.Thread, notice: string, m?: T.Msg): Promise<boolean> {
    const kind: Sobre["kind"] = m ? "msg" : notice.includes("ha aceptado el tunel") ? "accept" : notice.includes("cerrado (") ? "close" : "notice";
    const texto = m ? m.text : kind === "close" ? (t.closeReason ?? "cerrado") : notice;
    // Los ficheros van antes que el texto, para que el otro lado los tenga al leerlo.
    if (m?.files?.length) await this.enviarFicheros(t, m.files);
    return this.enviar(T.load(t.id) ?? t, { v: 1, id: t.id, kind, subject: t.subject, ...(m ? { kindOfMsg: m.kind } : {}) }, texto);
  }

  async aviso(t: T.Thread, texto: string) { await this.enviar(t, { v: 1, id: t.id, kind: "notice", subject: t.subject }, texto); }
  async pensandoOn(_t: T.Thread, _quien: string) {}
  async pensandoOff(_t: T.Thread) {}

  /** Pide a los reles que borren todo lo que este lado envio de este spoochie. */
  async borrarHilo(t: T.Thread): Promise<number> {
    let n = 0;
    for (const e of t.nostr?.enviados ?? []) {
      try { await Promise.any(this.pool.publish([...new Set([...t.nostr!.relays, ...this.relays])], peticionBorrado(e.id, e.wsk))); n++; } catch {}
    }
    return n;
  }

  /** El saludo del alta: le digo a quien me invito quien soy. */
  async hola(paraPk: string, relays: string[], nombre: string, slackId?: string): Promise<boolean> {
    const { wrap } = envolver(this.sk, paraPk, { v: 1, id: "hola", kind: "hola", fromName: nombre, slack: slackId, relays: this.relays }, `${nombre} ya esta en spoochie`);
    try { await Promise.any(this.pool.publish([...new Set([...relays, ...this.relays])], wrap)); return true; } catch { return false; }
  }
}
