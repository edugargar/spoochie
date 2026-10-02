/**
 * The protocol version, and what to do with an envelope we do not understand.
 *
 * The envelope has carried `v` since day one and nobody ever looked at it: it was a 1
 * written by hand in ten places. That works while only a 1 exists. As soon as a 2 ships,
 * an old spoochie would receive an envelope with fields it does not know and treat it as
 * if it understood them. It would deliver the text without the part that narrows it, or
 * without the part that holds it back.
 *
 * With the binary shipped per plugin version, two mismatched machines is the NORMAL case
 * for weeks, so the rule has to be written before it is needed, not after.
 *
 * The rule:
 *   v equal or lower   understood, delivered (each field carries its own backward
 *                      compatibility, like the v1 signature)
 *   v higher           NOT delivered. Said in the thread, with the sender's version, so
 *                      the person knows they have to update. Staying silent would be
 *                      worse: the other side would see "delivered" and nothing lands here.
 *   v absent           older than this field, treated as 1.
 */
export const PROTOCOL = 1;

export type Reading = { entiendo: true } | { entiendo: false; por: string };

export function readVersion(v: unknown, app?: string, mine = PROTOCOL): Reading {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  if (n <= mine) return { entiendo: true };
  return {
    entiendo: false,
    por: `speaks protocol ${n} and this spoochie understands up to ${mine}`
      + (app ? ` (the other machine is on ${app})` : "")
      + `. Update the plugin: /plugin marketplace update edugargar`,
  };
}
