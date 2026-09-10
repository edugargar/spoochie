/**
 * Firma de sobres. Sin esto el `from` de un sobre es lo que diga quien lo postea, y
 * todo el mundo postea con el mismo token de bot: cualquiera del equipo podia firmar
 * como cualquiera. Ahora cada persona tiene una clave ed25519 que nace en el alta;
 * la publica viaja en la invitacion y en cada sobre, y se fija la primera vez que se
 * ve (como SSH). A partir de ahi, un sobre de ese id con otra clave se descarta.
 */
import { createHash, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from "node:crypto";
import * as Cfg from "./config.ts";

export type Claves = { pub: string; priv: string };
/** El resultado de mirar la firma de un sobre.
 *   ok         firmada con la v2 y con la clave que ya tenia fijada para ese id
 *   nueva      primera vez que veo una clave para ese id: se fija, como SSH
 *   vieja      firma valida pero de la v1 (anterior a 0.9.9): no ata destinatario ni hora
 *   caducada   firma buena, pero el sobre es de hace mas de un dia o del futuro
 *   ajena      firma buena, pero el sobre iba dirigido a otra persona
 *   sin-firma  no trae firma
 *   mala       la firma no cuadra, o la clave no es la que tenia fijada */
export type Veredicto = "ok" | "nueva" | "vieja" | "caducada" | "ajena" | "sin-firma" | "mala";

export function nuevasClaves(): Claves {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** Slack toca el texto por el camino (escapa &, <, >, enlaza URLs). Se firma la forma
 *  que sobrevive al viaje, que es la misma que reconstruye `bodyFromBlocks`. */
export function canon(text: string): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/<(?:https?:\/\/)?[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<((?:https?|mailto):[^>]*)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/**
 * Lo que cubre una firma.
 *
 * La v1 firmaba id, kind, from y el hash del texto, y nada mas. Con eso, un sobre
 * legitimo seguia valiendo si alguien lo reenviaba a otra persona (no iba atado a un
 * destinatario), si lo volvia a postear meses despues (no llevaba hora), o si le
 * cambiaba el asunto, el hilo al que apunta o la version que dice traer (esos campos
 * viajaban fuera de la firma). La v2 ata todo eso.
 *
 * `to` y `thread` pueden ir vacios cuando no aplican, por ejemplo en un "hola", que se
 * deja en el DM antes de que exista ningun hilo. Lo que nunca va vacio es `ts`.
 */
export type DatosSobre = {
  id: string;
  kind: string;
  from: string;
  /** Para quien va, por su id de Slack. Vacio en un hola. */
  to?: string;
  /** Segundos desde epoch, puestos por quien firma. */
  ts?: number;
  /** Version de spoochie de quien firma: viajaba fuera de la firma y se podia cambiar. */
  app?: string;
  subject?: string;
  thread?: { channel: string; ts: string };
};

/** Cuanto vale una firma. Un sobre de hace mas de un dia no es un mensaje que llega
 *  tarde: es uno que alguien ha guardado. El limite es generoso a proposito, porque el
 *  reloj de las dos maquinas no tiene por que coincidir al minuto. */
export const VENTANA_MS = 24 * 60 * 60 * 1000;

const hash = (text: string) => createHash("sha256").update(canon(text)).digest("hex");

/** La v1, que se sigue comprobando para sobres de versiones anteriores. */
const datosV1 = (id: string, kind: string, from: string, text: string) =>
  Buffer.from(`${id}\n${kind}\n${from}\n${hash(text)}`);

/** La v2: un array en JSON, con el orden fijo y todos los campos presentes aunque esten
 *  vacios, para que dos sobres distintos no puedan producir los mismos bytes. */
const datosV2 = (d: DatosSobre, text: string) =>
  Buffer.from(JSON.stringify([
    2, d.id, d.kind, d.from, d.to ?? "", d.ts ?? 0, d.app ?? "", d.subject ?? "",
    d.thread ? `${d.thread.channel}/${d.thread.ts}` : "",
    hash(text),
  ]));

export function firmar(priv: string, d: DatosSobre, text: string): string {
  const key = createPrivateKey({ key: Buffer.from(priv, "base64"), type: "pkcs8", format: "der" });
  return sign(null, datosV2(d, text), key).toString("base64");
}

export function comprobar(pub: string, d: DatosSobre, text: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pub, "base64"), type: "spki", format: "der" });
    return verify(null, datosV2(d, text), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

/** La firma de antes de 0.9.9. Se exporta para poder probar que un sobre de la version
 *  anterior sigue verificando: nadie deberia firmar asi ya. */
export function firmarV1(priv: string, id: string, kind: string, from: string, text: string): string {
  const key = createPrivateKey({ key: Buffer.from(priv, "base64"), type: "pkcs8", format: "der" });
  return sign(null, datosV1(id, kind, from, text), key).toString("base64");
}

/** Igual, contra la firma de antes de 0.9.9. Solo para sobres sin `sv`. */
export function comprobarV1(pub: string, id: string, kind: string, from: string, text: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pub, "base64"), type: "spki", format: "der" });
    return verify(null, datosV1(id, kind, from, text), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

/** Mis claves, creandolas la primera vez. */
export function misClaves(c: Cfg.Config): Claves {
  if (!c.keys) { c.keys = nuevasClaves(); Cfg.save(c); }
  return c.keys;
}

/** Que hacer con un sobre que llega. Fija la clave la primera vez que se ve un id
 *  ("nueva"), y a partir de ahi exige la misma. Un sobre sin firma se entrega pero se
 *  dice: es de una version anterior o de alguien sin claves, y eso el humano lo tiene
 *  que ver. Uno con firma mala no se entrega. */
export type SobreAVerificar = DatosSobre & {
  fromName?: string;
  pk?: string;
  sig?: string;
  /** Version de la firma. 2 desde 0.9.9; ausente en sobres anteriores. */
  sv?: number;
};

export function verificarSobre(env: SobreAVerificar, text: string, ahora = Date.now()): Veredicto {
  if (!env.sig || !env.pk) return "sin-firma";

  if (env.sv === 2) {
    if (!comprobar(env.pk, env, text, env.sig)) return "mala";
    // Atado a un momento: un sobre bien firmado que alguien guardo y vuelve a soltar
    // no es un mensaje que llega tarde.
    const ts = (env.ts ?? 0) * 1000;
    if (!ts || Math.abs(ahora - ts) > VENTANA_MS) return "caducada";
    // Atado a un destinatario: reenviar a otra persona un sobre firmado para mi ya no
    // cuela. Un `to` vacio es el hola, que se deja antes de que haya hilo ni pareja.
    if (env.to) {
      const yo = Cfg.load().slack?.userId;
      if (yo && env.to !== yo) return "ajena";
    }
  } else if (!comprobarV1(env.pk, env.id, env.kind, env.from, text, env.sig)) {
    return "mala";
  }

  const c = Cfg.load();
  const conocido = Cfg.contactById(c, env.from);
  const vieja = env.sv !== 2;
  if (conocido?.pk) return conocido.pk === env.pk ? (vieja ? "vieja" : "ok") : "mala";
  Cfg.addContact(c, { id: env.from, name: conocido?.name ?? env.fromName ?? env.from, pk: env.pk });
  Cfg.save(c);
  return "nueva";
}
