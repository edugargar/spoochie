import { execFileSync } from "node:child_process";
import { ORIGIN } from "./origin.ts";

/** Lo que viaja en la invitacion. `u` es para quien va (asi el alta no tiene que
 *  buscarse a si mismo en Slack, que exige un scope que la app puede no tener) e `i`
 *  es quien invita, para que "@edu" resuelva en local sin llamar a Slack. */
export type Invite = {
  t?: string; u?: string; n?: string;
  /** Solo al leer: la cadena traia un token de bot (una invitacion de 0.9.7 o anterior
   *  hecha con --con-slack). No se guarda; se dice, porque quien la mando debe saber
   *  que ha repartido una credencial del equipo por un DM. */
  traiaToken?: boolean;
  /** Nonce de un solo uso: el hola de quien se da de alta lo devuelve, y sin el no
   *  entra ninguna clave en la agenda de quien invito (claves.ts). */
  k?: string;
  /** Quien invita: id de Slack (o "nostr:<pk>"), nombre, clave ed25519, clave Nostr y reles. */
  i?: { id: string; name: string; pk?: string; np?: string; r?: string[] };
};

/**
 * Lo que va dentro de una invitacion. Nunca un secreto.
 *
 * La cadena es JSON en base64: cualquiera la abre con un decodificador, y un companero
 * lo hizo el primer dia y vio el token de la app. 0.9.7 lo saco del camino normal y
 * dejo `--con-slack` para volver a meterlo; una bandera que reparte una credencial de
 * todo el equipo por un DM sigue siendo la misma fuga, solo que a peticion. Un
 * recien llegado no necesita el token: su demonio habla cifrado por los reles y los
 * avisos por DM se los manda el bot de quien le escribe.
 *
 * Lo que se pierde: quien entra hoy no puede hablar con alguien que siga en el
 * transporte de Slack de antes de 0.9. Esa persona actualiza; el token no viaja.
 */
export function inviteData(x: { team?: string; dest: { id: string; name: string }; yo: Invite["i"]; k?: string }): Invite {
  return { t: x.team, u: x.dest.id, n: x.dest.name, i: x.yo, k: x.k };
}

export function createInvite(inv: Invite): string {
  return Buffer.from(JSON.stringify(inv)).toString("base64url");
}

/** Lo que llega pegado nunca es la cadena limpia. Puede venir el comando entero
 *  ("spoochie join eyJ... --email x"), la barra del plugin ("/spoochie:join eyJ..."),
 *  comillas invertidas de Slack, o el trozo suelto. Se busca el unico token que
 *  puede ser base64url largo y se ignora todo lo demas. */
export function cleanString(entrada: string): string | null {
  const trozos = (entrada ?? "").replace(/[`'"]/g, " ").split(/\s+/).filter(Boolean);
  for (const t of trozos) {
    if (t.startsWith("--")) continue;
    if (/^[A-Za-z0-9_-]{40,}$/.test(t)) return t;
  }
  return null;
}

/** Una invitacion es un JSON en base64url con las claves publicas de quien invita.
 *  Si no descodifica o no trae clave Nostr, no es una invitacion: se dice, no se
 *  adivina. Un `b` de una version vieja se tira aqui y se avisa: aceptar un token que
 *  llega en una cadena pegada es exactamente lo que dejamos de hacer. */
export function readInvite(blob: string): Invite | null {
  try {
    const j = JSON.parse(Buffer.from(blob, "base64url").toString("utf8"));
    const conNostr = typeof j?.i?.np === "string" && /^[0-9a-f]{64}$/.test(j.i.np);
    if (!conNostr) return null;
    const inv: Invite = {};
    if (typeof j?.b === "string" && j.b) inv.traiaToken = true;
    if (typeof j.t === "string") inv.t = j.t;
    if (typeof j.u === "string" && /^[UW][A-Z0-9]{6,}$/.test(j.u)) inv.u = j.u;
    // Como se llama quien se da de alta, para que no firme con el usuario de su Mac.
    if (typeof j.n === "string" && j.n.trim()) inv.n = j.n.trim().slice(0, 60);
    // El nonce. Se quedaba fuera: `leerInvitacion` no lo copiaba, asi que `join` mandaba
    // el hola con `k` a undefined y del otro lado `canjearInvitacion` devolvia null. O
    // sea que el hola de alguien nuevo siempre caia en "sin invitacion valida y clave
    // desconocida", y el alta por Nostr no funcionaba: habia que anadir a mano con
    // --npub, que es el camino de repuesto, no el normal. Las dos mitades tenian test y
    // la costura entre ellas no.
    if (typeof j.k === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(j.k)) inv.k = j.k;
    if (j.i && typeof j.i.id === "string" && typeof j.i.name === "string") {
      // El nombre acaba en la agenda, en los avisos y en el titular del aviso. Sin
      // limite, quien invita elige cuanto ocupa en la pantalla de quien acepta.
      inv.i = { id: j.i.id.slice(0, 64), name: j.i.name.trim().slice(0, 60) };
      // La clave ed25519 va en base64 de un SPKI: son 44 caracteres. Una cadena
      // cualquiera se fijaba igual, y a partir de ahi todo sobre firmado de esa persona
      // daba "mala" sin que nadie supiera por que.
      if (typeof j.i.pk === "string" && /^[A-Za-z0-9+/]{40,100}={0,2}$/.test(j.i.pk)) inv.i.pk = j.i.pk;
      if (conNostr) inv.i.np = j.i.np;
      if (Array.isArray(j.i.r)) inv.i.r = j.i.r.filter((x: unknown) => typeof x === "string" && /^wss?:\/\//.test(x)).slice(0, 8);
    }
    return inv;
  } catch { return null; }
}

/** El DM que recibe quien se da de alta. Lleva todo lo que tiene que hacer, en
 *  orden, con la cadena ya dentro: no hay nada que pedir aparte. */
export function inviteText(blob: string, quien: string, repo = ORIGIN): string {
  const arroba = quien.toLowerCase().replace(/\s+/g, "");
  return [
    `${quien} te invita a spoochie: un tunel entre tu sesion de Claude Code y la suya.`,
    `Nadie escribe en tu maquina y ningun tunel se abre sin que tu aceptes.`,
    `La cadena de abajo solo lleva claves publicas de ${quien} y tu id de Slack. No hay ninguna contrasena dentro.`,
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
export function gitEmail(cwd = process.cwd()): string | undefined {
  try {
    const e = execFileSync("git", ["config", "--get", "user.email"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : undefined;
  } catch { return undefined; }
}
