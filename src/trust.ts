/**
 * Cuanta confianza le tienes a cada contacto, y que cambia eso.
 *
 * Hasta ahora la agenda era plana: un contacto era un id, un nombre y unas claves, y
 * todos valian igual. Tu companero de tres anos y quien entro ayer recibian el mismo
 * trato, que es a la vez demasiado estricto para el primero y una falsa tranquilidad
 * con el segundo.
 *
 * Lo que la confianza SI cambia:
 *
 *   nivel "alto"   las etiquetas de "fuera del asunto" no se publican en el hilo. Son
 *                  ruido cuando la persona ya sabe con quien habla, y el ruido acaba
 *                  en que nadie lee los avisos que si importan.
 *   auto <repo>    un spoochie de esa persona sobre ese repo se acepta sin sacar el
 *                  dialogo. Es consentimiento permanente y acotado: por persona y por
 *                  repo, nunca global.
 *
 * Lo que la confianza NO cambia, y no va a cambiar: la retencion de un mensaje que pide
 * actuar. La regla del vigilante es que el que envia no tiene por que ser de fiar, y eso
 * es justo porque la cuenta de alguien de confianza es la que mas caro sale cuando se la
 * quedan. Un nivel de confianza que abriera esa puerta convertiria la agenda en la
 * superficie de ataque, que es lo contrario de para lo que existe.
 */
import * as Cfg from "./config.ts";

export type Level = "alto" | "normal";

/** El contacto que hay detras de un remitente, sea id de Slack o clave Nostr. */
export function contactOf(c: Cfg.Config, remitente: { slackUser?: string; npub?: string }): { name: string; nivel?: Level; auto?: string[] } | null {
  if (remitente.slackUser) {
    const porId = Cfg.contactById(c, remitente.slackUser);
    if (porId) return porId as { name: string; nivel?: Level; auto?: string[] };
  }
  if (remitente.npub) {
    const porClave = Cfg.contactByNpub(c, remitente.npub);
    if (porClave) return porClave as { name: string; nivel?: Level; auto?: string[] };
  }
  return null;
}

export function levelOf(c: Cfg.Config, remitente: { slackUser?: string; npub?: string }): Level {
  return contactOf(c, remitente)?.nivel === "alto" ? "alto" : "normal";
}

/** El nombre corto de un repo: el ultimo trozo de su ruta. Es lo que escribe la
 *  persona al dar el consentimiento, y lo que ve en `spoochie contacts`. */
export const repoName = (cwd: string) => cwd.replace(/\/+$/, "").split("/").pop() ?? "";

/**
 * Si un spoochie de esta persona sobre este repo entra sin sacar el dialogo.
 *
 * Solo con las dos cosas a la vez. Sin repo no hay consentimiento: "confio en Sam" a
 * secas seria una llave maestra a todas las maquinas donde trabajas, y el repo es
 * justo lo que acota que puede leer el Claude que conteste.
 */
export function autoAccepts(c: Cfg.Config, remitente: { slackUser?: string; npub?: string }, cwd: string): boolean {
  const contacto = contactOf(c, remitente);
  if (!contacto?.auto?.length) return false;
  return contacto.auto.includes(repoName(cwd));
}

/** Da o quita el consentimiento permanente de un contacto para un repo. */
export function trust(c: Cfg.Config, nombre: string, repo: string, quitar = false): { ok: false; error: string } | { ok: true; repos: string[] } {
  const clave = Cfg.contactKey(nombre);
  const contacto = c.contacts?.[clave] as { auto?: string[] } | undefined;
  if (!contacto) return { ok: false, error: `no tengo a "${nombre}" en la agenda` };
  const repos = new Set(contacto.auto ?? []);
  if (quitar) repos.delete(repo); else repos.add(repo);
  contacto.auto = [...repos].sort();
  return { ok: true, repos: contacto.auto };
}

export function setLevel(c: Cfg.Config, nombre: string, nivel: Level): { ok: false; error: string } | { ok: true } {
  const clave = Cfg.contactKey(nombre);
  const contacto = c.contacts?.[clave] as { nivel?: Level } | undefined;
  if (!contacto) return { ok: false, error: `no tengo a "${nombre}" en la agenda` };
  if (nivel === "normal") delete contacto.nivel; else contacto.nivel = nivel;
  return { ok: true };
}

/** "hace 4 min", "hace 3 h", "hace 2 dias". Sin decimales: es una orientacion, no un dato. */
export function ago(cuando: number, ahora = Date.now()): string {
  const min = Math.floor((ahora - cuando) / 60000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} dias`;
}
