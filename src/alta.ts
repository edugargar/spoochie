import { execFileSync } from "node:child_process";
import { ORIGEN } from "./origen.ts";

/** Lo que viaja en la invitacion. `u` es para quien va (asi el alta no tiene que
 *  buscarse a si mismo en Slack, que exige un scope que la app puede no tener) e `i`
 *  es quien invita, para que "@edu" resuelva en local sin llamar a Slack. */
export type Invitacion = {
  /** Token del bot de Slack. Puede faltar: una invitacion solo por Nostr. */
  b?: string;
  t?: string; u?: string; n?: string;
  /** Nonce de un solo uso: el hola de quien se da de alta lo devuelve, y sin el no
   *  entra ninguna clave en la agenda de quien invito (claves.ts). */
  k?: string;
  /** Quien invita: id de Slack (o "nostr:<pk>"), nombre, clave ed25519, clave Nostr y reles. */
  i?: { id: string; name: string; pk?: string; np?: string; r?: string[] };
};

/**
 * Lo que va dentro de una invitacion por Slack. El token del bot solo con `conSlack`:
 * la cadena es JSON en base64, cualquiera la abre con un decodificador, y un companero
 * lo hizo el primer dia y vio el token de la app. Con Nostr el recien llegado no lo
 * necesita: su demonio habla cifrado por los reles, y los avisos por DM se los manda el
 * bot de quien le escribe. Sin el token, la cadena solo lleva claves publicas y su id.
 */
export function datosInvitacion(x: { bot: string; team?: string; dest: { id: string; name: string }; yo: Invitacion["i"]; conSlack?: boolean; k?: string }): Invitacion {
  return { ...(x.conSlack ? { b: x.bot } : {}), t: x.team, u: x.dest.id, n: x.dest.name, i: x.yo, k: x.k };
}

export function crearInvitacion(inv: Invitacion): string {
  return Buffer.from(JSON.stringify(inv)).toString("base64url");
}

/** Lo que llega pegado nunca es la cadena limpia. Puede venir el comando entero
 *  ("spoochie join eyJ... --email x"), la barra del plugin ("/spoochie:join eyJ..."),
 *  comillas invertidas de Slack, o el trozo suelto. Se busca el unico token que
 *  puede ser base64url largo y se ignora todo lo demas. */
export function limpiarCadena(entrada: string): string | null {
  const trozos = (entrada ?? "").replace(/[`'"]/g, " ").split(/\s+/).filter(Boolean);
  for (const t of trozos) {
    if (t.startsWith("--")) continue;
    if (/^[A-Za-z0-9_-]{40,}$/.test(t)) return t;
  }
  return null;
}

/** Una invitacion es un JSON en base64url con el token del bot dentro. Si no
 *  descodifica o no trae token, no es una invitacion: se dice, no se adivina. */
export function leerInvitacion(blob: string): Invitacion | null {
  try {
    const j = JSON.parse(Buffer.from(blob, "base64url").toString("utf8"));
    const conSlack = typeof j?.b === "string" && j.b;
    const conNostr = typeof j?.i?.np === "string" && /^[0-9a-f]{64}$/.test(j.i.np);
    if (!conSlack && !conNostr) return null;
    const inv: Invitacion = conSlack ? { b: j.b } : {};
    if (typeof j.t === "string") inv.t = j.t;
    if (typeof j.u === "string" && /^[UW][A-Z0-9]{6,}$/.test(j.u)) inv.u = j.u;
    // Como se llama quien se da de alta, para que no firme con el usuario de su Mac.
    if (typeof j.n === "string" && j.n.trim()) inv.n = j.n.trim().slice(0, 60);
    if (j.i && typeof j.i.id === "string" && typeof j.i.name === "string") {
      inv.i = { id: j.i.id, name: j.i.name };
      if (typeof j.i.pk === "string") inv.i.pk = j.i.pk;
      if (conNostr) inv.i.np = j.i.np;
      if (Array.isArray(j.i.r)) inv.i.r = j.i.r.filter((x: unknown) => typeof x === "string" && /^wss?:\/\//.test(x)).slice(0, 8);
    }
    return inv;
  } catch { return null; }
}

/** El DM que recibe quien se da de alta. Lleva todo lo que tiene que hacer, en
 *  orden, con la cadena ya dentro: no hay nada que pedir aparte. */
export function textoInvitacion(blob: string, quien: string, repo = ORIGEN, conToken = false): string {
  const arroba = quien.toLowerCase().replace(/\s+/g, "");
  return [
    `${quien} te invita a spoochie: un tunel entre tu sesion de Claude Code y la suya.`,
    `Nadie escribe en tu maquina y ningun tunel se abre sin que tu aceptes.`,
    conToken
      ? `La cadena de abajo lleva el token del bot de Slack de la app: no la pegues en ningun sitio publico.`
      : `La cadena de abajo solo lleva claves publicas de ${quien} y tu id de Slack. No hay ninguna contrasena dentro.`,
    ``,
    `Para entrar no hace falta instalar nada antes:`,
    `1. En Claude Code:  /plugin marketplace add ${repo}`,
    `2. Despues:         /plugin install spoochie@${repo.split("/")[0]}`,
    `3. Reinicia Claude Code (la primera vez tarda unos segundos: se baja lo que necesita).`,
    `4. Pega esto en Claude Code, entero:`,
    `/spoochie:join ${blob}`,
    ``,
    `Tu Claude te dira si estas dentro. Para probar, pidele: "abre un spoochie con @${arroba} y preguntale que es esto".`,
  ].join("\n");
}

/** El email de trabajo casi siempre esta ya en git, y pedirlo otra vez es un paso
 *  mas en el unico sitio donde estamos contando pasos. Si no cuadra con Slack, el
 *  que se da de alta lo pasa a mano; el error dice cual se intento. */
export function emailDeGit(cwd = process.cwd()): string | undefined {
  try {
    const e = execFileSync("git", ["config", "--get", "user.email"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : undefined;
  } catch { return undefined; }
}
