/**
 * El aviso de un spoochie que llega, fuera de cualquier terminal.
 *
 * La invitacion entraba en la sesion de Claude donde la persona estaba trabajando, y
 * eso ensuciaba justo la terminal que no habia que tocar: su Claude se ponia a hablar
 * del spoochie en mitad de otra cosa. Ahora, en macOS, el aviso es un dialogo del
 * sistema: quien lo abre, el asunto, la pregunta, y tres botones. Aceptar abre la
 * ventana del Claude aparte; Rechazar cierra el tunel; Ver en Slack abre el hilo, donde
 * tambien se puede aceptar escribiendo. Ninguna sesion interactiva se entera.
 *
 * Sin escritorio (Linux, tests) se vuelve a la entrega en la terminal. SPOOCHIE_AVISO
 * lo fija: "terminal", "dialogo", o un programa que recibe el texto y responde con el
 * nombre del boton (para los tests).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as T from "./threads.ts";
// El logo, como icono del dialogo. Con `type: "file"` Bun lo empaqueta dentro del binario
// compilado y aqui llega una ruta valida en los dos casos, fuente o binario.
import poochie from "../docs/spoochie.png" with { type: "file" };

export type Respuesta = "acepto" | "rechazo" | "slack" | null;
export type Modo = "dialogo" | "terminal";

export function modoAviso(): Modo {
  const v = process.env.SPOOCHIE_AVISO;
  if (v === "terminal") return "terminal";
  if (v && v !== "dialogo") return "dialogo";
  return process.platform === "darwin" ? "dialogo" : "terminal";
}

/** El cuerpo se recorta por frases, no por caracteres: cortar a mitad de palabra y
 *  pegar "[...]" es lo que hace que un aviso parezca un log y no un mensaje. */
const MAX_CUERPO = 280;

function recortar(texto: string): string {
  const limpio = texto.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  if (limpio.length <= MAX_CUERPO) return limpio;
  const corte = limpio.slice(0, MAX_CUERPO);
  const fin = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("? "), corte.lastIndexOf("! "));
  return (fin > MAX_CUERPO / 2 ? corte.slice(0, fin + 1) : corte.replace(/\s+\S*$/, "")) + " …";
}

/**
 * El texto del aviso.
 *
 * Cuatro bloques y ni una etiqueta: quien llama, que quiere, lo que ha dicho, y que
 * pasa si abres. Antes habia cinco entradillas de broma que rotaban por el id del hilo
 * ("Poochie ha vuelto de su planeta con un recado"), dos lineas con etiqueta ("Asunto:",
 * "Rama:") y un parrafo final de tres frases. Eran 5 lineas de adorno alrededor de 2 de
 * informacion, y lo primero que leia la persona no era quien llamaba.
 *
 * La gracia la pone el icono, que es Poochie, y el boton, que sigue siendo "Que pase".
 * En el texto no hace falta repetirla: un aviso que interrumpe tiene un segundo para
 * decir lo que es.
 */
export function partesDialogo(t: T.Thread): { titular: string; cuerpo: string } {
  const quien = t.from.human ?? t.from.name;
  // La linea de contexto, con punto medio, y solo con lo que exista de verdad: una
  // etiqueta vacia ("Rama: -") es peor que no ponerla.
  const contexto = [
    t.context.branch,
    t.context.files?.length ? `${t.context.files.length} ${t.context.files.length === 1 ? "fichero" : "ficheros"}` : null,
  ].filter(Boolean).join("  ·  ");
  const asunto = t.subject.trim();
  return {
    titular: `${quien} llama.`,
    cuerpo: [
      asunto.charAt(0).toUpperCase() + asunto.slice(1),
      contexto || null,
      ``,
      `“${recortar(t.messages[0]?.text ?? "")}”`,
      ``,
      `Le contesta un Claude de solo lectura, en una ventana aparte. Tus sesiones no se enteran.`,
    ].filter(x => x !== null).join("\n"),
  };
}

/** Todo seguido, para la caja que no separa titular de cuerpo (y para los tests). */
export function textoDialogo(t: T.Thread): string {
  const { titular, cuerpo } = partesDialogo(t);
  return `${titular}\n\n${cuerpo}`;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const BOTONES = { rechazar: "Ahora no", slack: "Ver en Slack", aceptar: "Que pase" };

function interpretar(salida: string, codigo: number | null): Respuesta {
  if (/gave up:true/.test(salida)) return null;
  if (salida.includes(`button returned:${BOTONES.aceptar}`) || /^\s*(Aceptar|Que pase)\s*$/m.test(salida)) return "acepto";
  if (salida.includes(`button returned:${BOTONES.slack}`) || /^\s*Ver en Slack\s*$/m.test(salida)) return "slack";
  if (salida.includes(`button returned:${BOTONES.rechazar}`) || /^\s*(Rechazar|Ahora no)\s*$/m.test(salida)) return "rechazo";
  // El boton de cancelar hace que osascript termine con error "User canceled".
  if (codigo !== 0 && /canceled|cancelled|-128/i.test(salida)) return "rechazo";
  return null;
}

/**
 * El AppleScript que pinta la caja.
 *
 * Probado tambien con `display alert`, que separa titular y cuerpo y es lo que da la
 * jerarquia tipografica de los avisos del sistema. RECHAZADO despues de verlo en
 * pantalla: `display alert` no admite icono propio, asi que en vez de Poochie sale la
 * carpeta naranja generica de osascript; la caja es mas estrecha y parte las frases a
 * media linea; y los tres botones se apilan en vertical, que hace que el aviso parezca
 * un error del sistema en vez de alguien llamando. La negrita del titular no compensa
 * ninguna de las tres. `partesDialogo` sigue devolviendo titular y cuerpo por separado
 * porque el DM de Slack y el primer turno del aparte los usan.
 */
export function guionOsascript(t: T.Thread, esperaSeg = 3600): string {
  const icono = existsSync(poochie) ? ` with icon POSIX file "${esc(poochie)}"` : "";
  return `display dialog "${esc(textoDialogo(t))}" with title "spoochie"${icono}`
    + ` buttons {"${BOTONES.rechazar}", "${BOTONES.slack}", "${BOTONES.aceptar}"}`
    + ` default button "${BOTONES.aceptar}" cancel button "${BOTONES.rechazar}" giving up after ${esperaSeg}`;
}

/** Muestra el aviso y espera al boton. Hasta una hora; si nadie pulsa, null. */
export function preguntar(t: T.Thread, esperaSeg = 3600): { child: ChildProcess; respuesta: Promise<Respuesta> } {
  const texto = textoDialogo(t);
  const custom = process.env.SPOOCHIE_AVISO;
  const child = custom && custom !== "dialogo"
    ? spawn(custom, [texto], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn("osascript", ["-e", guionOsascript(t, esperaSeg)], { stdio: ["ignore", "pipe", "pipe"] });
  let salida = "";
  child.stdout?.on("data", d => { salida += d.toString(); });
  child.stderr?.on("data", d => { salida += d.toString(); });
  const respuesta = new Promise<Respuesta>(resolve => {
    child.on("error", () => resolve(null));
    child.on("close", codigo => resolve(interpretar(salida, codigo)));
  });
  return { child, respuesta };
}

/** Abre el hilo del spoochie en la app de Slack. */
export function abrirEnSlack(teamId: string | null, channel: string, ts: string) {
  const url = teamId
    ? `slack://channel?team=${teamId}&id=${channel}&message=${ts.replace(".", "")}`
    : `https://slack.com/app_redirect?channel=${channel}`;
  const p = spawn("open", [url], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
}
