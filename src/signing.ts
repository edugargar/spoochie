/**
 * Envelope signatures. Without this, an envelope's `from` is whatever the poster says,
 * and everyone posts with the same bot token: anyone on the team could sign as anyone.
 * Now each person has an ed25519 key born at join; the public half travels in the invite
 * and in every envelope, and is pinned the first time it is seen (like SSH). From then on,
 * an envelope from that id with a different key is dropped.
 */
import { createHash, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from "node:crypto";
import * as Cfg from "./config.ts";

export type Keys = { pub: string; priv: string };
/** The result of checking an envelope's signature.
 *   ok           signed with v2 and with the key already pinned for that id
 *   nueva        first time I see a key for that id: it gets pinned, like SSH
 *   vieja        valid signature but v1 (before 0.9.9): binds neither recipient nor time
 *   caducada     good signature, but the envelope is more than a day old or from the future
 *   ajena        good signature, but the envelope was addressed to someone else
 *   desconocida  the signature checks out, but that id is not in your contacts: you did
 *                not invite them and they did not invite you, so their key is not pinned
 *   degradada    no signature, but I already had a key pinned for that id
 *   sin-firma    no signature, and I know nothing about that id yet
 *   mala         the signature does not check out, or the key is not the pinned one */
export type Verdict = "ok" | "nueva" | "vieja" | "caducada" | "ajena" | "degradada" | "desconocida" | "sin-firma" | "mala";

export function newKeys(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** Slack touches the text in transit (escapes &, <, >, links URLs). What gets signed is
 *  the form that survives the trip, which is the same one `bodyFromBlocks` rebuilds. */
export function canon(text: string): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/<(?:https?:\/\/)?[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<((?:https?|mailto):[^>]*)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/**
 * What a signature covers.
 *
 * v1 signed id, kind, from and the text hash, and nothing else. With that, a legitimate
 * envelope stayed valid if someone forwarded it to another person (it was not bound to a
 * recipient), reposted it months later (it carried no time), or changed its subject, the
 * thread it points to or the version it claims (those fields travelled outside the
 * signature). v2 binds all of that.
 *
 * `to` and `thread` may be empty when they do not apply, for example in a "hola", which
 * is left in the DM before any thread exists. `ts` is never empty.
 */
export type EnvelopeData = {
  id: string;
  kind: string;
  from: string;
  /** Who it is for, by Slack id. Empty in a hello. */
  to?: string;
  /** Seconds since epoch, set by the signer. */
  ts?: number;
  /** The signer's spoochie version: it travelled outside the signature and could be changed. */
  app?: string;
  subject?: string;
  thread?: { channel: string; ts: string };
  /** Whether the turn is text, patch or branch. It travelled outside the signature, and it
   *  decides whether the guardian reads the message: `kind !== "text"` skips it entirely.
   *  So changing one word nobody signed switched the guardian off for that message. */
  kindOfMsg?: string;
};

/** How long a signature is good for. An envelope more than a day old is not a message
 *  that arrived late: it is one someone kept. The limit is generous on purpose, because
 *  the clocks on the two machines need not agree to the minute. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

const hash = (text: string) => createHash("sha256").update(canon(text)).digest("hex");

/** v1, still checked for envelopes from earlier versions. */
const signedBytesV1 = (id: string, kind: string, from: string, text: string) =>
  Buffer.from(`${id}\n${kind}\n${from}\n${hash(text)}`);

/** v2: a JSON array, fixed order and every field present even when empty, so two
 *  different envelopes cannot produce the same bytes.
 *
 *  `kindOfMsg` is in here because it decides whether the guardian reads the message: the
 *  guardian skips anything that is not "text", so that word, which nobody signed, was
 *  worth the whole guardian. It can be added without breaking anyone because v2 has not
 *  shipped in any published version: the latest is 0.9.8 and it signs with v1. */
const signedBytesV2 = (d: EnvelopeData, text: string) =>
  Buffer.from(JSON.stringify([
    2, d.id, d.kind, d.from, d.to ?? "", d.ts ?? 0, d.app ?? "", d.subject ?? "",
    d.thread ? `${d.thread.channel}/${d.thread.ts}` : "",
    d.kindOfMsg ?? "",
    hash(text),
  ]));

export function makeSignature(priv: string, d: EnvelopeData, text: string): string {
  const key = createPrivateKey({ key: Buffer.from(priv, "base64"), type: "pkcs8", format: "der" });
  return sign(null, signedBytesV2(d, text), key).toString("base64");
}

export function checkSignature(pub: string, d: EnvelopeData, text: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pub, "base64"), type: "spki", format: "der" });
    return verify(null, signedBytesV2(d, text), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

/** The signature from before 0.9.9. Exported so a test can prove that an envelope from
 *  the previous version still verifies: nobody should sign this way anymore. */
export function makeSignatureV1(priv: string, id: string, kind: string, from: string, text: string): string {
  const key = createPrivateKey({ key: Buffer.from(priv, "base64"), type: "pkcs8", format: "der" });
  return sign(null, signedBytesV1(id, kind, from, text), key).toString("base64");
}

/** Same, against the signature from before 0.9.9. Only for envelopes with no `sv`. */
export function checkSignatureV1(pub: string, id: string, kind: string, from: string, text: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pub, "base64"), type: "spki", format: "der" });
    return verify(null, signedBytesV1(id, kind, from, text), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

/** My keys, created the first time. */
export function myKeys(c: Cfg.Config): Keys {
  if (!c.keys) { c.keys = newKeys(); Cfg.save(c); }
  return c.keys;
}

/** What to do with an incoming envelope. Pins the key the first time an id is seen
 *  ("nueva"), and from then on demands the same one. An unsigned envelope is delivered
 *  but labelled: it comes from an earlier version or from someone without keys, and the
 *  human has to see that. One with a bad signature is not delivered. */
export type EnvelopeToVerify = EnvelopeData & {
  fromName?: string;
  pk?: string;
  sig?: string;
  /** Signature version. 2 since 0.9.9; absent in earlier envelopes. */
  sv?: number;
};

export function verifyEnvelope(env: EnvelopeToVerify, text: string, now = Date.now()): Verdict {
  if (!env.sig || !env.pk) {
    // If I already have a key pinned for that id, an unsigned envelope from them is not
    // an old version: it is someone stripping the signature to slip through the door we
    // left open for old versions. Tolerating that turns the signature into decoration,
    // because attacking would just mean not signing.
    return Cfg.contactById(Cfg.load(), env.from)?.pk ? "degradada" : "sin-firma";
  }

  if (env.sv === 2) {
    if (!checkSignature(env.pk, env, text, env.sig)) return "mala";
    // Bound to a moment: a correctly signed envelope that someone kept and releases
    // again is not a message that arrived late.
    const ts = (env.ts ?? 0) * 1000;
    if (!ts || Math.abs(now - ts) > WINDOW_MS) return "caducada";
    // Bound to a recipient: forwarding to someone else an envelope signed for me no
    // longer works. An empty `to` is the hello, sent before there is any thread or pair.
    if (env.to) {
      const me = Cfg.load().slack?.userId;
      if (me && env.to !== me) return "ajena";
    }
  } else if (!checkSignatureV1(env.pk, env.id, env.kind, env.from, text, env.sig)) {
    return "mala";
  }

  const c = Cfg.load();
  const known = Cfg.contactById(c, env.from);
  const old = env.sv !== 2;
  if (known?.pk) return known.pk === env.pk ? (old ? "vieja" : "ok") : "mala";
  // The 0.9.8 rule stated in full, and here, which is where ALL traffic passes: a key is
  // pinned the first time it is seen, but only for an id already in your contacts, that
  // is, someone you invited or who invited you. This function used to add the sender to
  // your contacts just for seeing an envelope from them, under the name they gave
  // themselves, so anyone able to post with the bot token got into the whole team's
  // contacts by writing once.
  if (!known) return "desconocida";
  Cfg.addContact(c, { id: env.from, name: known.name ?? env.fromName ?? env.from, pk: env.pk });
  Cfg.save(c);
  return "nueva";
}
