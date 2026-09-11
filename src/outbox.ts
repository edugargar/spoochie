/**
 * Buzon de salida con union, y en disco.
 *
 * Un Claude que cree que el canal corta manda su respuesta en 23 mensajes seguidos, y
 * en Slack eso es una pared de trozos numerados. Los mensajes de texto del mismo lado
 * que caen en la misma ventana salen como uno solo. Dos segundos y medio no se notan
 * al lado de lo que tarda un modelo en pensar.
 *
 * Lo pendiente se apunta en ~/.claude/spoochie/outbox.json: un reinicio del demonio (una
 * actualizacion, un launchd que lo relanza) ya no se lleva los mensajes que estaban
 * esperando su ventana, ni los que Slack rechazo; al arrancar se reanudan, y lo que
 * falla se reintenta cada minuto hasta que sale.
 *
 * Vive aparte del demonio porque importar daemon.ts levanta un demonio, y esto se
 * prueba mejor sin uno.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import * as T from "./threads.ts";
import { OUTBOX_FILE, ensureDirs, escribirAtomico } from "./paths.ts";

export const UNION_MS = 2_500;
export const REINTENTO_MS = 60_000;

export type Salida = (t: T.Thread, m: T.Msg) => Promise<boolean | void>;

type Caja = { msgs: T.Msg[]; timer: ReturnType<typeof setTimeout> | null; fallos: number };
const outbox = new Map<string, Caja>();
let salidaPorDefecto: Salida | null = null;
let reintento: ReturnType<typeof setInterval> | null = null;

function guardar() {
  ensureDirs();
  const datos = [...outbox].map(([key, c]) => ({ key, msgs: c.msgs, fallos: c.fallos }));
  try {
    if (datos.length) escribirAtomico(OUTBOX_FILE, JSON.stringify(datos));
    else if (existsSync(OUTBOX_FILE)) unlinkSync(OUTBOX_FILE);
  } catch {}
}

function unir(msgs: T.Msg[]): T.Msg {
  const unido: T.Msg = {
    ...msgs[0],
    text: msgs.map(x => x.text).join("\n\n"),
    // Los ficheros de TODOS los mensajes unidos, no solo los del primero:
    // al juntar se perdian los adjuntos de los que venian detras.
    files: msgs.flatMap(x => x.files ?? []).filter((f, i, a) => a.indexOf(f) === i),
  };
  if (!unido.files?.length) delete unido.files;
  return unido;
}

async function sacar(key: string, salida: Salida) {
  const caja = outbox.get(key);
  if (!caja) return;
  caja.timer = null;
  const fresco = T.load(key.split(":")[0]);
  if (!fresco) { outbox.delete(key); guardar(); return; }
  let ok: boolean | void = false;
  try { ok = await salida(fresco, unir(caja.msgs)); } catch { ok = false; }
  if (ok === false) { caja.fallos++; guardar(); return; }
  outbox.delete(key);
  guardar();
}

/** Cola un mensaje; sale solo cuando pasa la ventana de union sin que llegue otro. */
export function encolar(t: T.Thread, m: T.Msg, salida: Salida, ventanaMs = UNION_MS) {
  const key = `${t.id}:${m.from}`;
  // Un parche o una rama no se unen con nada: van tal cual.
  if (m.kind !== "text") { void salida(t, m); return; }
  const caja = outbox.get(key) ?? { msgs: [], timer: null, fallos: 0 };
  if (caja.timer) clearTimeout(caja.timer);
  caja.msgs.push(m);
  outbox.set(key, caja);
  guardar();
  caja.timer = setTimeout(() => { void sacar(key, salida); }, ventanaMs);
}

/** Lo que quedo en disco de un demonio anterior sale ahora; lo que falle, cada minuto. */
export function reanudar(salida: Salida): number {
  salidaPorDefecto = salida;
  let n = 0;
  if (existsSync(OUTBOX_FILE)) {
    try {
      for (const d of JSON.parse(readFileSync(OUTBOX_FILE, "utf8")) as { key: string; msgs: T.Msg[]; fallos?: number }[]) {
        if (!d.msgs?.length || outbox.has(d.key)) continue;
        outbox.set(d.key, { msgs: d.msgs, timer: null, fallos: d.fallos ?? 0 });
        n++;
      }
    } catch {}
    for (const key of [...outbox.keys()]) void sacar(key, salida);
  }
  if (!reintento) {
    reintento = setInterval(() => {
      if (!salidaPorDefecto) return;
      for (const [key, c] of outbox) if (!c.timer) void sacar(key, salidaPorDefecto);
    }, REINTENTO_MS);
    reintento.unref();
  }
  return n;
}

/** Para los tests y `doctor`: cuantos mensajes esperan salir. */
export function pendientes(): number {
  return [...outbox.values()].reduce((a, c) => a + c.msgs.length, 0);
}
