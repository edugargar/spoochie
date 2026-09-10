/**
 * El centinela: comprueba que el Claude aparte contesto por el tunel antes de callarse.
 *
 * Por que existe. El aparte tiene un solo trabajo: leer el repo y contestar con
 * `spoochie say`. Si termina su turno sin hacerlo (porque decidio que la pregunta no
 * le tocaba, porque el portero le corto algo y se rindio, o porque simplemente hablo
 * hacia la ventana), no pasa nada visible: la persona ve una ventana quieta y el otro
 * lado ve silencio hasta que el reloj de los 10 minutos cierra el spoochie. Nadie se
 * entera de que hubo una respuesta que no salio.
 *
 * Es un hook `Stop`. Mira el hilo en disco: si el ultimo mensaje es del otro lado, es
 * que no hemos contestado, y se bloquea la parada con el motivo. Una sola vez por
 * turno: si Claude Code dice que ya bloqueamos (`stop_hook_active`), se deja pasar,
 * porque un aparte atrapado en un bucle es peor que un aparte callado.
 */
import * as T from "./threads.ts";

export type Decision = { decision?: "block"; reason?: string };

/** Lo que decide, ya con el hilo cargado. Separado para poder probarlo sin ficheros. */
export function juzgarTurno(t: T.Thread | null, sessionId: string, yaBloqueado: boolean): Decision {
  if (!t) return {};
  if (t.state !== "open") return {};
  if (yaBloqueado) return {};

  const mio = T.mySide(t, sessionId).sessionId;
  // Solo cuentan los mensajes que de verdad entraron: uno retenido por el vigilante no
  // esta esperando respuesta, esta esperando a que su humano lo suelte.
  const entregados = t.messages.filter(m => m.retenido !== "si" && m.retenido !== "descartado");
  const ultimo = entregados[entregados.length - 1];
  if (!ultimo || ultimo.from === mio) return {};

  return {
    decision: "block",
    reason: `Todavia no has contestado por el tunel. El ultimo mensaje del spoochie ${t.id} es del otro lado y sigue esperando.`
      + ` Contesta con:  spoochie say ${t.id} "<texto>"  (o --file <ruta> si es largo).`
      + ` Si no puedes contestar lo que piden, dilo igualmente por el tunel y cierra con:  spoochie close ${t.id} --reason "..."`
      + ` Lo que escribas aqui no sale de esta ventana.`,
  };
}

/** El hook entero, de la entrada de Claude Code a la decision. */
export function centinela(entrada: unknown, id: string | undefined, sessionId: string | undefined): Decision {
  if (!id || !sessionId) return {};
  const e = entrada as { stop_hook_active?: boolean } | null;
  return juzgarTurno(T.load(id), sessionId, Boolean(e?.stop_hook_active));
}
