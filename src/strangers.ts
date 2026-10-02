/**
 * Who has tried to talk to me without being in my contacts.
 *
 * Over Nostr, an envelope from an unknown key was dropped with one line in the daemon
 * log, and so was a rejected join hello. On 14-09 that left two people knowing nothing:
 * Adrian's join came from a 0.9.8, his hello arrived without the invite nonce, and his
 * spoochie was then dropped as "key not in contacts". Edu saw nothing, and the fix was
 * reading the relays by hand.
 *
 * What gets written down here is just enough to decide: the key, the name and the Slack
 * id the envelope CLAIMS (none of it is checked), what kind of envelope it was and when.
 * Never the subject or the text: that is not mine to keep, and what was said is deleted
 * on close. `spoochie doctor` shows it, and `spoochie contacts --bind` is the way out
 * when the person is who they say they are.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs, writeAtomic } from "./paths.ts";

export type Stranger = {
  pk: string;
  /** What the envelope says. Unchecked. */
  nombre?: string;
  slack?: string;
  kind: string;
  motivo?: string;
  primera: number;
  ultima: number;
  /** When the person was last interrupted about this key. */
  avisado?: number;
  veces: number;
};

const FILE = () => join(ROOT, "desconocidos.json");
const MAX = 20;
const DAY_MS = 24 * 3600_000;
export const REMEMBER_MS = 7 * DAY_MS;

function readAll(): Stranger[] {
  try { return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : []; } catch { return []; }
}

const clean = (s: unknown, max: number) => typeof s === "string"
  ? s.replace(/[\u0000-\u001f\u007f\u2028\u2029\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined
  : undefined;

/**
 * Records an attempt. Returns true if it is the first from that key in a day, which is
 * when it is worth interrupting the person; repeats only bump the count.
 */
export function record(x: { pk: string; kind: string; nombre?: unknown; slack?: unknown; motivo?: string }, now = Date.now()): boolean {
  if (!/^[0-9a-f]{64}$/.test(x.pk)) return false;
  const all = readAll().filter(d => now - d.ultima < REMEMBER_MS);
  const prev = all.find(d => d.pk === x.pk);
  // The day counts from the last notice, not from the last attempt: otherwise a key that
  // keeps trying every hour would never notify again.
  const fresh = !prev || now - (prev.avisado ?? prev.primera) >= DAY_MS;
  const slack = typeof x.slack === "string" && /^[UW][A-Z0-9]{6,20}$/.test(x.slack) ? x.slack : undefined;
  const d: Stranger = {
    pk: x.pk,
    nombre: clean(x.nombre, 60) ?? prev?.nombre,
    slack: slack ?? prev?.slack,
    kind: clean(x.kind, 20) ?? "?",
    motivo: clean(x.motivo, 120),
    primera: prev?.primera ?? now,
    ultima: now,
    veces: (prev?.veces ?? 0) + 1,
    avisado: fresh ? now : prev?.avisado,
  };
  const rest = all.filter(o => o.pk !== x.pk);
  ensureDirs();
  writeAtomic(FILE(), JSON.stringify([d, ...rest].sort((a, b) => b.ultima - a.ultima).slice(0, MAX)));
  return fresh;
}

export function recent(now = Date.now()): Stranger[] {
  return readAll().filter(d => now - d.ultima < REMEMBER_MS).sort((a, b) => b.ultima - a.ultima);
}

export function forget(pk: string) {
  const all = readAll();
  const kept = all.filter(d => d.pk !== pk);
  if (kept.length !== all.length) writeAtomic(FILE(), JSON.stringify(kept));
}
