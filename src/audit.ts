/**
 * The log of what people decided.
 *
 * `daemon.log` exists and is good for debugging, but it mixes everything and gets rotated
 * without a second look: what lives there is a process's state. What is missing is the
 * other question, the one asked after something happens: who opened, who accepted, what
 * the guardian held back, who released it and when. Today that is spread across the Slack
 * thread (deleted on close), the transcript (same) and the daemon log (nobody reads it).
 *
 * It goes here, one line per fact, in plain text, never deleted. Only facts and names,
 * never the text of the messages: deleting on close has to stay true, and a log that kept
 * the conversation would turn it into a lie.
 */
import { appendFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs } from "./paths.ts";

export const FILE = join(ROOT, "auditoria.log");

export type Event =
  | "abierto" | "aceptado" | "aceptado-solo" | "rechazado" | "cerrado"
  | "retenido" | "soltado" | "descartado"
  | "clave-fijada" | "clave-rechazada" | "sobre-descartado"
  | "confianza";

/** One line: when, what, which spoochie, and who. The detail is short and carries no
 *  message text. Never throws: nobody wants a log that breaks the flow. */
export function record(event: Event, id: string, who: string, detail = "") {
  try {
    ensureDirs();
    const line = [new Date().toISOString(), event, id, who.replace(/\t/g, " "), detail.replace(/[\t\n]/g, " ").slice(0, 200)].join("\t") + "\n";
    appendFileSync(FILE, line);
    chmodSync(FILE, 0o600);
  } catch {}
}

export type Line = { cuando: string; hecho: string; id: string; quien: string; detalle: string };

export function read(n = 50, text?: string): Line[] {
  const raw = text ?? (existsSync(FILE) ? readFileSync(FILE, "utf8") : "");
  return raw.split("\n").filter(Boolean).slice(-n).map(l => {
    const [cuando, hecho, id, quien, detalle] = l.split("\t");
    return { cuando: cuando ?? "", hecho: hecho ?? "", id: id ?? "", quien: quien ?? "", detalle: detalle ?? "" };
  });
}
