/**
 * El aviso de un spoochie que llega, fuera de cualquier terminal.
 *
 * La invitacion entraba en la sesion de Claude donde la persona estaba trabajando, y
 * eso ensuciaba justo la terminal que no habia que tocar: su Claude se ponia a hablar
 * del spoochie en mitad de otra cosa. Ahora, en macOS, el aviso es una ventana del
 * sistema: quien lo abre, el asunto, lo que ha dicho, y tres botones. Aceptar abre la
 * ventana del Claude aparte; Rechazar cierra el tunel; Ver en Slack abre el hilo, donde
 * tambien se puede aceptar escribiendo. Ninguna sesion interactiva se entera.
 *
 * Como se pinta esa ventana esta en `ventana.ts`. Aqui esta lo de fuera: elegir pintor,
 * leer el boton, y el plan B.
 *
 * Sin escritorio (Linux, tests) se vuelve a la entrega en la terminal. SPOOCHIE_AVISO
 * lo fija: "terminal", "dialogo", o un programa que recibe el texto y responde con el
 * nombre del boton (para los tests).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as T from "./threads.ts";
import * as V from "./ventana.ts";
// El logo, como icono del aviso. Con `type: "file"` Bun lo empaqueta dentro del binario
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

/**
 * El aviso en texto plano.
 *
 * La ventana nativa coloca cada pieza por su cuenta; esto es la version de una sola
 * columna, que es lo que reciben el plan B (`display dialog`) y el programa de los
 * tests. Las dos salen de `V.piezas`, asi que no pueden decir cosas distintas.
 */
export function partesDialogo(t: T.Thread): { titular: string; cuerpo: string } {
  const p = V.piezas(t);
  return {
    titular: p.quien,
    cuerpo: [p.asunto, p.contexto || null, ``, `“${p.cita}”`, ``, p.pie.replace(/\n/g, " ")]
      .filter(x => x !== null).join("\n"),
  };
}

/** Todo seguido, para la caja que no separa titular de cuerpo (y para los tests). */
export function textoDialogo(t: T.Thread): string {
  const { titular, cuerpo } = partesDialogo(t);
  return `${titular}\n\n${cuerpo}`;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const BOTONES = V.BOTONES;

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
 * El plan B: la caja de AppleScript de toda la vida.
 *
 * Se usa solo si el programa de la ventana no arranca. No es hipotetico: `NSWindow`,
 * `NSVisualEffectView` y `ObjC.registerSubclass` los pone el sistema, y una version de
 * macOS que cambie cualquiera de los tres deja a la persona sin aviso ninguno. Un aviso
 * feo es infinitamente mejor que un spoochie que nadie ve llegar.
 *
 * `display alert`, que separa titular de cuerpo, se probo y se rechazo: no admite icono
 * propio (sale la carpeta naranja generica de osascript), la caja es mas estrecha y
 * parte las frases, y los tres botones se apilan en vertical, que hace que parezca un
 * error del sistema en vez de alguien llamando.
 */
export function guionOsascript(t: T.Thread, esperaSeg = 3600): string {
  const icono = existsSync(poochie) ? ` with icon POSIX file "${esc(poochie)}"` : "";
  return `display dialog "${esc(textoDialogo(t))}" with title "spoochie"${icono}`
    + ` buttons {"${BOTONES.rechazar}", "${BOTONES.slack}", "${BOTONES.aceptar}"}`
    + ` default button "${BOTONES.aceptar}" cancel button "${BOTONES.rechazar}" giving up after ${esperaSeg}`;
}

/** El programa JXA de la ventana, con el icono si existe. */
export function guionVentana(t: T.Thread): string {
  return V.guionVentana(t, existsSync(poochie) ? poochie : null);
}

type Aviso = { cerrar: () => void; respuesta: Promise<Respuesta> };

function correr(cmd: string, args: string[]): { child: ChildProcess; fin: Promise<{ salida: string; codigo: number | null }> } {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let salida = "";
  child.stdout?.on("data", d => { salida += d.toString(); });
  child.stderr?.on("data", d => { salida += d.toString(); });
  const fin = new Promise<{ salida: string; codigo: number | null }>(resolve => {
    child.on("error", () => resolve({ salida, codigo: -1 }));
    child.on("close", codigo => resolve({ salida, codigo }));
  });
  return { child, fin };
}

/**
 * Muestra el aviso y espera al boton. Hasta una hora; si nadie pulsa, null.
 *
 * La espera la lleva este lado y no `giving up after`, porque la ventana nativa no tiene
 * esa clausula y con un temporizador aqui las dos rutas caducan igual. Matar al hijo da
 * el mismo null que el "gave up:true" de AppleScript.
 */
export function preguntar(t: T.Thread, esperaSeg = 3600): Aviso {
  const custom = process.env.SPOOCHIE_AVISO;
  let vivo: ChildProcess | null = null;
  let matado = false;
  const cerrar = () => { matado = true; try { vivo?.kill(); } catch {} };

  const respuesta = (async (): Promise<Respuesta> => {
    if (custom && custom !== "dialogo") {
      const { child, fin } = correr(custom, [textoDialogo(t)]);
      vivo = child;
      const r = await fin;
      return interpretar(r.salida, r.codigo);
    }
    const ventana = correr("osascript", ["-l", "JavaScript", "-e", guionVentana(t)]);
    vivo = ventana.child;
    const r = await ventana.fin;
    const leida = interpretar(r.salida, r.codigo);
    if (leida !== null || matado || r.codigo === 0) return leida;
    // La ventana no llego a pintarse. Se dice en el log del demonio por stderr y se
    // vuelve a preguntar con la caja de siempre.
    console.error("spoochie: la ventana del aviso no arranco, voy con el dialogo simple:", r.salida.trim().split("\n")[0] ?? "");
    const caja = correr("osascript", ["-e", guionOsascript(t, esperaSeg)]);
    vivo = caja.child;
    const r2 = await caja.fin;
    return interpretar(r2.salida, r2.codigo);
  })();

  const reloj = setTimeout(cerrar, esperaSeg * 1000);
  if (typeof (reloj as any).unref === "function") (reloj as any).unref();
  void respuesta.then(() => clearTimeout(reloj));
  return { cerrar, respuesta };
}

/**
 * Una notificacion del sistema, sin botones. Para lo que la persona tiene que saber
 * pero no tiene que contestar ya.
 *
 * El texto va como argumento de `on run argv`, nunca pegado dentro del guion: parte de
 * lo que se ensena lo dice un sobre de fuera, y con comillas en un nombre el guion
 * seria suyo. Sin escritorio, o con SPOOCHIE_AVISO fijado (los tests), no hace nada.
 */
export function notificar(titulo: string, texto: string): boolean {
  if (process.platform !== "darwin" || process.env.SPOOCHIE_AVISO) return false;
  const guion = "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run";
  const p = spawn("osascript", ["-e", guion, titulo, texto], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
  return true;
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
