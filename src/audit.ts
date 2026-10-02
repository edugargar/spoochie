/**
 * El registro de lo que decidieron las personas.
 *
 * `daemon.log` existe y sirve para depurar, pero mezcla todo y se rota sin mirar: lo
 * que hay ahi son estados de un proceso. Lo que falta es la otra pregunta, la que se
 * hace despues de que pase algo: quien abrio, quien acepto, que retuvo el vigilante,
 * quien lo solto y cuando. Eso hoy esta repartido entre el hilo de Slack (que se borra
 * al cerrar), el transcript (que tambien) y el log del demonio (que no lo lee nadie).
 *
 * Aqui va, en una linea por hecho, en texto plano y sin borrarse nunca. Solo hechos y
 * nombres, nunca el texto de los mensajes: el borrado al cerrar tiene que seguir siendo
 * verdad, y un registro que guardara la conversacion lo convertiria en mentira.
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

/** Una linea: cuando, que, sobre que spoochie, y quien. El detalle es corto y sin texto
 *  del mensaje. Nunca lanza: un registro que rompe el flujo no lo quiere nadie. */
export function record(hecho: Event, id: string, quien: string, detalle = "") {
  try {
    ensureDirs();
    const linea = [new Date().toISOString(), hecho, id, quien.replace(/\t/g, " "), detalle.replace(/[\t\n]/g, " ").slice(0, 200)].join("\t") + "\n";
    appendFileSync(FILE, linea);
    chmodSync(FILE, 0o600);
  } catch {}
}

export type Line = { cuando: string; hecho: string; id: string; quien: string; detalle: string };

export function read(n = 50, texto?: string): Line[] {
  const bruto = texto ?? (existsSync(FILE) ? readFileSync(FILE, "utf8") : "");
  return bruto.split("\n").filter(Boolean).slice(-n).map(l => {
    const [cuando, hecho, id, quien, detalle] = l.split("\t");
    return { cuando: cuando ?? "", hecho: hecho ?? "", id: id ?? "", quien: quien ?? "", detalle: detalle ?? "" };
  });
}
