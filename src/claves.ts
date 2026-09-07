/**
 * Quien puede poner una clave Nostr en tu agenda, y cuando.
 *
 * Antes, un "hola" valia por si mismo: el que llegaba por Nostr decia "soy el Slack
 * U_SAM, esta es mi clave" y la agenda le creia; el que llegaba por Slack venia sin
 * firma y cualquiera con el token del bot podia escribirlo. Con tu npub (publico, va
 * en cada invitacion) y el id de Slack de un companero, un desconocido en internet
 * sustituia la clave de ese companero y tus siguientes spoochies, cifrados y todo,
 * iban a el. Revisado el 07-09 a raiz del token en la invitacion.
 *
 * Ahora:
 * - Una clave que ya esta en la agenda no se sustituye por ningun hola. Se cambia a
 *   mano (`spoochie contacts --olvidar-clave`), y el intento queda en el log.
 * - Un hola por Nostr solo vale con el nonce de una invitacion tuya sin canjear, y se
 *   vincula a lo que TU apuntaste al invitar (id y nombre), no a lo que diga el hola.
 *   Sin nonce, solo se acepta de una clave que ya esta en la agenda (cambio de reles).
 * - Un hola por Slack solo vale firmado con la clave ed25519 ya fijada de ese id
 *   ("ok"), o de un id que ya esta en la agenda sin clave fijada ("nueva").
 */
import { randomBytes } from "node:crypto";
import * as Cfg from "./config.ts";
import type { Veredicto } from "./firma.ts";

export const INVITACION_CADUCA_MS = 30 * 24 * 3600 * 1000;

/** Apunta una invitacion pendiente y devuelve su nonce, que va dentro de la cadena. */
export function nuevaInvitacion(c: Cfg.Config, dest: { id?: string; name?: string }, ahora = Date.now()): string {
  const k = randomBytes(16).toString("base64url");
  podar(c, ahora);
  c.invitaciones = { ...(c.invitaciones ?? {}), [k]: { id: dest.id, name: dest.name, at: ahora } };
  return k;
}

/** Canjea un nonce: devuelve lo apuntado al invitar y lo borra. Null si no vale. */
export function canjearInvitacion(c: Cfg.Config, k: string | undefined, ahora = Date.now()): { id?: string; name?: string } | null {
  if (!k || !c.invitaciones?.[k]) return null;
  podar(c, ahora);
  const inv = c.invitaciones?.[k];
  if (!inv) return null;
  delete c.invitaciones![k];
  return { id: inv.id, name: inv.name };
}

function podar(c: Cfg.Config, ahora: number) {
  for (const [k, v] of Object.entries(c.invitaciones ?? {})) if (ahora - v.at > INVITACION_CADUCA_MS) delete c.invitaciones![k];
}

export type Vinculo = "nueva" | "igual" | "conflicto";

/** Pone la clave a un contacto si no tenia; si tenia otra, no la toca y lo dice. */
export function vincularClave(c: Cfg.Config, p: { id: string; name: string; npub: string; relays?: string[] }): Vinculo {
  const porId = Cfg.contactById(c, p.id) as { npub?: string } | null;
  if (porId?.npub && porId.npub !== p.npub) return "conflicto";
  const porClave = Cfg.contactoPorNpub(c, p.npub);
  if (porClave && porClave.id !== p.id) return "conflicto";
  const igual = porId?.npub === p.npub;
  Cfg.addContact(c, { id: p.id, name: p.name, npub: p.npub, relays: p.relays });
  return igual ? "igual" : "nueva";
}

export type Decision = { ok: true; id: string; name: string; vinculo: Vinculo } | { ok: false; motivo: string };

/** Un hola que llega por Nostr: `de` es la clave que firmo el sello (eso si es seguro). */
export function holaPorNostr(c: Cfg.Config, x: { de: string; nombre: string; k?: string; relays?: string[] }, ahora = Date.now()): Decision {
  const inv = canjearInvitacion(c, x.k, ahora);
  const conocido = Cfg.contactoPorNpub(c, x.de);
  if (!inv && !conocido) return { ok: false, motivo: "sin invitacion valida y clave desconocida" };
  const id = inv?.id ?? conocido?.id ?? `nostr:${x.de}`;
  const name = inv?.name ?? conocido?.name ?? x.nombre;
  const vinculo = vincularClave(c, { id, name, npub: x.de, relays: x.relays });
  if (vinculo === "conflicto") return { ok: false, motivo: `${name} ya tiene otra clave; no se sustituye` };
  return { ok: true, id, name, vinculo };
}

/** Un hola que llega por Slack: `de` es el id de Slack que dice el sobre, y solo vale con firma. */
export function holaPorSlack(c: Cfg.Config, x: { de: string; nombre: string; np: string; relays?: string[]; veredicto: Veredicto }): Decision {
  const conocido = Cfg.contactById(c, x.de);
  if (x.veredicto === "mala" || x.veredicto === "sin-firma") return { ok: false, motivo: `hola de ${x.de} ${x.veredicto === "mala" ? "con firma que no es suya" : "sin firmar"}` };
  if (x.veredicto === "nueva" && !conocido) return { ok: false, motivo: `hola de un id que no esta en la agenda (${x.de})` };
  const name = conocido?.name ?? x.nombre;
  const vinculo = vincularClave(c, { id: x.de, name, npub: x.np, relays: x.relays });
  if (vinculo === "conflicto") return { ok: false, motivo: `${name} ya tiene otra clave; no se sustituye` };
  return { ok: true, id: x.de, name, vinculo };
}
