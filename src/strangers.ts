/**
 * Quien ha intentado hablarme sin estar en mi agenda.
 *
 * Por Nostr, un sobre de una clave desconocida se tiraba con una linea en el log del
 * demonio, y un saludo de alta rechazado igual. El 14-09 eso dejo a dos personas sin
 * saber nada: el alta de Adrian venia de una 0.9.8, su saludo llego sin el nonce de la
 * invitacion, y su spoochie despues se tiro por "clave que no esta en la agenda". Edu no
 * vio nada, y el arreglo fue leer los reles a mano.
 *
 * Aqui queda apuntado lo justo para decidir: la clave, el nombre y el id de Slack QUE
 * DICE el sobre (nada de eso esta comprobado), que tipo de sobre era y cuando. Nunca el
 * asunto ni el texto: no es mio guardarlo, y lo que se dijo se borra al cerrar.
 * `spoochie doctor` lo ensena, y `spoochie contacts --vincular` es la salida cuando la
 * persona es quien dice ser.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs, writeAtomic } from "./paths.ts";

export type Stranger = {
  pk: string;
  /** Lo que dice el sobre. Sin comprobar. */
  nombre?: string;
  slack?: string;
  kind: string;
  motivo?: string;
  primera: number;
  ultima: number;
  /** Cuando se interrumpio a la persona por ultima vez por esta clave. */
  avisado?: number;
  veces: number;
};

const FICHERO = () => join(ROOT, "desconocidos.json");
const MAX = 20;
const DIA_MS = 24 * 3600_000;
export const REMEMBER_MS = 7 * DIA_MS;

function leerTodo(): Stranger[] {
  try { return existsSync(FICHERO()) ? JSON.parse(readFileSync(FICHERO(), "utf8")) : []; } catch { return []; }
}

const limpio = (s: unknown, max: number) => typeof s === "string"
  ? s.replace(/[\u0000-\u001f\u007f\u2028\u2029\[\]`]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined
  : undefined;

/**
 * Apunta un intento. Devuelve true si es el primero de esa clave en un dia, que es
 * cuando merece interrumpir a la persona; los repetidos solo suben la cuenta.
 */
export function record(x: { pk: string; kind: string; nombre?: unknown; slack?: unknown; motivo?: string }, ahora = Date.now()): boolean {
  if (!/^[0-9a-f]{64}$/.test(x.pk)) return false;
  const todos = leerTodo().filter(d => ahora - d.ultima < REMEMBER_MS);
  const previo = todos.find(d => d.pk === x.pk);
  // El dia cuenta desde el ultimo aviso, no desde el ultimo intento: si no, una clave
  // que insiste cada hora no volveria a avisar nunca.
  const nuevo = !previo || ahora - (previo.avisado ?? previo.primera) >= DIA_MS;
  const slack = typeof x.slack === "string" && /^[UW][A-Z0-9]{6,20}$/.test(x.slack) ? x.slack : undefined;
  const d: Stranger = {
    pk: x.pk,
    nombre: limpio(x.nombre, 60) ?? previo?.nombre,
    slack: slack ?? previo?.slack,
    kind: limpio(x.kind, 20) ?? "?",
    motivo: limpio(x.motivo, 120),
    primera: previo?.primera ?? ahora,
    ultima: ahora,
    veces: (previo?.veces ?? 0) + 1,
    avisado: nuevo ? ahora : previo?.avisado,
  };
  const resto = todos.filter(o => o.pk !== x.pk);
  ensureDirs();
  writeAtomic(FICHERO(), JSON.stringify([d, ...resto].sort((a, b) => b.ultima - a.ultima).slice(0, MAX)));
  return nuevo;
}

export function recent(ahora = Date.now()): Stranger[] {
  return leerTodo().filter(d => ahora - d.ultima < REMEMBER_MS).sort((a, b) => b.ultima - a.ultima);
}

export function forget(pk: string) {
  const todos = leerTodo();
  const quedan = todos.filter(d => d.pk !== pk);
  if (quedan.length !== todos.length) writeAtomic(FICHERO(), JSON.stringify(quedan));
}
