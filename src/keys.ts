/**
 * Who can put a Nostr key in your contacts, and when.
 *
 * A "hola" used to count on its own. One arriving over Nostr said "I am Slack user U_SAM,
 * here is my key" and the contacts believed it; one arriving over Slack came unsigned and
 * anyone with the bot token could write it. With your npub (public, it is in every
 * invite) and a teammate's Slack id, a stranger on the internet replaced that teammate's
 * key and your next spoochies, encrypted and all, went to them. Reviewed on 07-09 after
 * the token-in-the-invite issue.
 *
 * Now:
 * - A key already in your contacts is never replaced by a hello. It is changed by hand
 *   (`spoochie contacts --forget-key`), and the attempt goes to the log.
 * - A hello over Nostr only counts with the nonce of an unredeemed invite of yours, and it
 *   is bound to what YOU wrote down when inviting (id and name), not to what the hello
 *   says. Without a nonce, it is only accepted from a key already in your contacts
 *   (a relay change).
 * - A hello over Slack only counts signed with the ed25519 key already pinned for that id
 *   ("ok"), or from an id already in your contacts with no pinned key ("nueva").
 */
import { randomBytes } from "node:crypto";
import * as Cfg from "./config.ts";
import type { Verdict } from "./signing.ts";

export const INVITE_EXPIRES_MS = 30 * 24 * 3600 * 1000;

/** Records a pending invite and returns its nonce, which goes inside the invite string. */
export function newInvite(c: Cfg.Config, dest: { id?: string; name?: string }, now = Date.now()): string {
  const k = randomBytes(16).toString("base64url");
  prune(c, now);
  c.invitaciones = { ...(c.invitaciones ?? {}), [k]: { id: dest.id, name: dest.name, at: now } };
  return k;
}

/** Redeems a nonce: returns what was recorded when inviting and deletes it. Null if it is not valid. */
export function redeemInvite(c: Cfg.Config, k: string | undefined, now = Date.now()): { id?: string; name?: string } | null {
  if (!k || !c.invitaciones?.[k]) return null;
  prune(c, now);
  const inv = c.invitaciones?.[k];
  if (!inv) return null;
  delete c.invitaciones![k];
  return { id: inv.id, name: inv.name };
}

function prune(c: Cfg.Config, now: number) {
  for (const [k, v] of Object.entries(c.invitaciones ?? {})) if (now - v.at > INVITE_EXPIRES_MS) delete c.invitaciones![k];
}

export type Binding = "nueva" | "igual" | "conflicto";

/** Gives a contact the key if they had none; if they had another, leaves it and says so. */
export function bindKey(c: Cfg.Config, p: { id: string; name: string; npub: string; relays?: string[] }): Binding {
  const byId = Cfg.contactById(c, p.id) as { npub?: string } | null;
  if (byId?.npub && byId.npub !== p.npub) return "conflicto";
  const byKey = Cfg.contactByNpub(c, p.npub);
  if (byKey && byKey.id !== p.id) return "conflicto";
  const same = byId?.npub === p.npub;
  Cfg.addContact(c, { id: p.id, name: p.name, npub: p.npub, relays: p.relays });
  return same ? "igual" : "nueva";
}

export type Decision = { ok: true; id: string; name: string; vinculo: Binding } | { ok: false; motivo: string };

/** A hello arriving over Nostr: `de` is the key that signed the seal (that part is trustworthy). */
export function helloByNostr(c: Cfg.Config, x: { de: string; nombre: string; k?: string; relays?: string[] }, now = Date.now()): Decision {
  const inv = redeemInvite(c, x.k, now);
  const known = Cfg.contactByNpub(c, x.de);
  if (!inv && !known) return { ok: false, motivo: "no valid invite and unknown key" };
  const id = inv?.id ?? known?.id ?? `nostr:${x.de}`;
  const name = inv?.name ?? known?.name ?? x.nombre;
  const binding = bindKey(c, { id, name, npub: x.de, relays: x.relays });
  if (binding === "conflicto") return { ok: false, motivo: `${name} already has another key; not replacing it` };
  return { ok: true, id, name, vinculo: binding };
}

/** A hello arriving over Slack: `de` is the Slack id the envelope claims, and it only counts if signed. */
export function helloBySlack(c: Cfg.Config, x: { de: string; nombre: string; np: string; relays?: string[]; veredicto: Verdict }): Decision {
  const known = Cfg.contactById(c, x.de);
  if (x.veredicto === "mala" || x.veredicto === "sin-firma") return { ok: false, motivo: `hello from ${x.de} ${x.veredicto === "mala" ? "with a signature that is not theirs" : "unsigned"}` };
  if (x.veredicto === "nueva" && !known) return { ok: false, motivo: `hello from an id that is not in your contacts (${x.de})` };
  const name = known?.name ?? x.nombre;
  const binding = bindKey(c, { id: x.de, name, npub: x.np, relays: x.relays });
  if (binding === "conflicto") return { ok: false, motivo: `${name} already has another key; not replacing it` };
  return { ok: true, id: x.de, name, vinculo: binding };
}

/**
 * An incoming signing key rotation.
 *
 * Only accepted if the envelope was signed with the key ALREADY pinned for that id
 * ("ok"). "nueva" does not count: that would be someone we knew nothing about debuting
 * with a key change, which is exactly what we do not want.
 */
export function incomingRotation(c: Cfg.Config, from: string, newPk: string, verdict: Verdict): { ok: false; por: string } | { ok: true; nombre: string; antes: string } {
  if (verdict !== "ok") return { ok: false, por: `the rotation signature does not match the pinned key (${verdict})` };
  const x = Cfg.contactById(c, from);
  if (!x?.pk) return { ok: false, por: "there was no key pinned for that id" };
  if (!/^[A-Za-z0-9+/=]{20,}$/.test(newPk)) return { ok: false, por: "the new key does not look like a key" };
  if (x.pk === newPk) return { ok: false, por: "the new key is the same one already pinned" };
  const before = x.pk;
  Cfg.addContact(c, { id: x.id, name: x.name, pk: newPk });
  return { ok: true, nombre: x.name, antes: before };
}
