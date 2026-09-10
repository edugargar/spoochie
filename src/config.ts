import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs } from "./paths.ts";
import * as L from "./llavero.ts";

export type Config = {
  /** Nombre con el que te ven los demas. Por defecto, tu usuario del sistema. */
  human?: string;
  /** El vigilante de tema cuesta una llamada a Haiku por mensaje. */
  guardian: boolean;
  /** Publicar el transcript como Artifact al abrir y en cada turno. */
  transcript: boolean;
  /** Los spoochies que llegan los atiende un Claude aparte (claude -p en el repo), no la
   *  sesion donde trabajas. Esa solo recibe el aviso. Apagado, todo entra en tu sesion. */
  aparte?: boolean;
  /** El Claude aparte trabaja sobre una copia limpia del repo (git worktree de HEAD),
   *  no sobre tu checkout: aunque algo se colara por la lista de herramientas, tus
   *  ficheros no se tocan. Pega: lo que no este commiteado (.env, cambios locales) no
   *  esta en la copia. Apagado, atiende en el checkout real. */
  aparteCopia?: boolean;
  /** Al cerrar un spoochie se borra la conversacion: en local (quedan id, asunto, quien y
   *  cuando) y en el transporte (en Slack, todo lo que posteo el bot; lo que escribio una
   *  persona a mano se queda, el bot no puede borrarlo). Por defecto si. */
  borrarAlCerrar?: boolean;
  /** Quien te invito, y a quien has invitado. "@edu" se resuelve aqui antes de
   *  preguntar a Slack, que para buscar por nombre exige users:read. */
  contacts?: Record<string, {
    id: string; name: string; pk?: string; npub?: string; relays?: string[];
    /** Nivel de confianza. "alto" calla las etiquetas de "fuera del asunto", que son
     *  ruido cuando ya sabes con quien hablas. Nunca abre la retencion de lo que pide
     *  actuar: ver confianza.ts. */
    nivel?: "alto" | "normal";
    /** Consentimiento permanente y acotado: nombres de repo cuyos spoochies de esta
     *  persona entran sin sacar el dialogo. Por persona Y por repo, nunca global. */
    auto?: string[];
    /** Cuando llego el ultimo sobre suyo. Es lo mas cerca de "esta ahi" que se puede
     *  decir sin inventarse un sondeo: no dice si esta ahora, dice cuando estuvo. */
    visto?: number;
  }>;
  /** Invitaciones sin canjear, por nonce: a quien se invito y cuando. Un hola por Nostr
   *  solo entra con uno de estos (claves.ts). Caducan a los 30 dias. */
  invitaciones?: Record<string, { id?: string; name?: string; at: number }>;
  /** Claves Nostr (secp256k1, hex) y reles de esta persona. Nacen en el alta. */
  nostr?: { sk?: string; pk?: string; relays?: string[] };
  /** Por donde van los spoochies con quien tiene clave Nostr: "nostr" (por defecto si
   *  los dos la tienen) o "slack". Slack sigue avisando por DM en los dos casos. */
  transporte?: "nostr" | "slack";
  /** Clave ed25519 con la que se firman los sobres. Nace en el alta. */
  keys?: { pub: string; priv: string };
  slack?: {
    /** Token de usuario (xoxp-) de tu app de Slack, obtenido por OAuth. Tuyo, no compartido.
     *  Vacio si usas tokenFile. Ya no hace falta para nada: con el de bot basta. */
    userToken?: string;
    /** Fichero JSON del que leer el token, para no tener una segunda copia que rotar
     *  si otra herramienta tuya ya guarda uno. */
    tokenFile?: string;
    /** Clave dentro de ese JSON. Por defecto "userToken". */
    tokenKey?: string;
    /** Token de bot (xoxb-) de la app. Es credencial de la app, no personal: todo
     *  el trafico de spoochie vive en el DM entre el bot y cada persona, que es
     *  UN canal por maquina que consultar en vez de los 197 DMs de alguien. */
    botToken?: string;
    botTokenKey?: string;
    /** Tu id de usuario en Slack, para saber que mensajes del hilo son tuyos. */
    userId: string;
    /** Donde vive el hilo de cada spoochie que abres. "grupo": un grupo de mensajes
     *  directos bot + tu + la otra persona, que veis los dos (necesita mpim:write,
     *  mpim:read y mpim:history en la app). "canal": un canal fijo (`canal`), que ve
     *  todo el que este en el. "dm": el DM entre el bot y quien recibe, que tu no ves.
     *  Por defecto "grupo", y si la app no tiene los permisos se cae a "dm" avisando. */
    hilos?: "grupo" | "canal" | "dm";
    canal?: string;
    /** Cada cuanto se miran los hilos abiertos. */
    pollMs: number;
  };
};

const FILE = join(ROOT, "config.json");
const DEFAULTS: Config = { guardian: true, transcript: false, aparte: true };

export function load(): Config {
  ensureDirs();
  if (!existsSync(FILE)) return { ...DEFAULTS };
  try { return rellenarDelLlavero({ ...DEFAULTS, ...JSON.parse(readFileSync(FILE, "utf8")) }); }
  catch { return { ...DEFAULTS }; }
}

/**
 * Cambia las senales `@llavero` por el secreto de verdad. Si el llavero no contesta se
 * deja la senal: mejor que spoochie diga "no tengo clave" a que firme con la cadena
 * "@llavero" y el otro lado descarte los sobres sin saber por que.
 */
export function rellenarDelLlavero(c: Config): Config {
  const necesita = c.keys?.priv === L.SENAL || c.nostr?.sk === L.SENAL || c.slack?.botToken === L.SENAL;
  if (!necesita) return c;
  if (c.keys?.priv === L.SENAL) { const v = L.leer(L.CUENTAS.firma); if (v) c.keys = { ...c.keys, priv: v }; }
  if (c.nostr?.sk === L.SENAL) { const v = L.leer(L.CUENTAS.nostr); if (v) c.nostr = { ...c.nostr, sk: v }; }
  if (c.slack?.botToken === L.SENAL) { const v = L.leer(L.CUENTAS.bot); if (v) c.slack = { ...c.slack!, botToken: v }; }
  return c;
}

/** Mueve los tres secretos al llavero y deja la senal en el fichero. Devuelve cuales. */
export function alLlavero(c: Config): string[] {
  const movidos: string[] = [];
  if (c.keys?.priv && c.keys.priv !== L.SENAL && L.guardar(L.CUENTAS.firma, c.keys.priv)) { c.keys.priv = L.SENAL; movidos.push("clave de firma"); }
  if (c.nostr?.sk && c.nostr.sk !== L.SENAL && L.guardar(L.CUENTAS.nostr, c.nostr.sk)) { c.nostr.sk = L.SENAL; movidos.push("clave Nostr"); }
  if (c.slack?.botToken && c.slack.botToken !== L.SENAL && L.guardar(L.CUENTAS.bot, c.slack.botToken)) { c.slack.botToken = L.SENAL; movidos.push("token del bot"); }
  return movidos;
}

/** Los saca del llavero y los devuelve al fichero. Para poder deshacer. */
export function delLlavero(c: Config): string[] {
  const vueltos: string[] = [];
  const par: [keyof typeof L.CUENTAS, (v: string) => void][] = [
    ["firma", v => { c.keys = { ...c.keys!, priv: v }; }],
    ["nostr", v => { c.nostr = { ...c.nostr, sk: v }; }],
    ["bot", v => { c.slack = { ...c.slack!, botToken: v }; }],
  ];
  for (const [cuenta, poner] of par) {
    const v = L.leer(L.CUENTAS[cuenta]);
    if (v) { poner(v); L.borrar(L.CUENTAS[cuenta]); vueltos.push(cuenta); }
  }
  return vueltos;
}

/** El token, venga de donde venga. Leerlo del fichero de otra herramienta en vez de
 *  copiarlo evita tener dos copias que rotar por separado. */
export function slackToken(c: Config): string | null {
  if (c.slack?.userToken) return c.slack.userToken;
  if (!c.slack?.tokenFile) return null;
  try {
    const j = JSON.parse(readFileSync(c.slack.tokenFile, "utf8"));
    const t = j[c.slack.tokenKey ?? "userToken"];
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}

/** El token de bot, del mismo fichero si hace falta. */
export function slackBotToken(c: Config): string | null {
  if (c.slack?.botToken) return c.slack.botToken;
  if (!c.slack?.tokenFile) return null;
  try {
    const t = JSON.parse(readFileSync(c.slack.tokenFile, "utf8"))[c.slack.botTokenKey ?? "botToken"];
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}

/** Guarda un contacto por su nombre en minusculas y sin espacios, que es como se
 *  escribe despues de la arroba. */
export function contactoPorNpub(c: Config, pk: string): { id: string; name: string; pk?: string; npub?: string; relays?: string[] } | null {
  return Object.values(c.contacts ?? {}).find(x => x.npub === pk) ?? null;
}

export function addContact(c: Config, p: { id: string; name: string; pk?: string; npub?: string; relays?: string[] }) {
  // Si ya estaba por otro nombre (o con clave), se conserva lo que ya se sabia.
  const previo = contactById(c, p.id);
  if (previo) {
    for (const [k, v] of Object.entries(c.contacts ?? {})) if (v.id === p.id) delete c.contacts![k];
  }
  // El nombre lo pone el emisor del sobre y no va firmado: un id nuevo que se llame
  // "Edu" no puede quedarse con la entrada del Edu de verdad. Va con sufijo.
  let clave = claveContacto(p.name);
  const ocupada = c.contacts?.[clave];
  if (ocupada && ocupada.id !== p.id) clave = `${clave}-${p.id.slice(-4).toLowerCase()}`;
  c.contacts = { ...(c.contacts ?? {}), [clave]: { ...previo, ...p, pk: p.pk ?? previo?.pk, npub: p.npub ?? previo?.npub, relays: p.relays ?? previo?.relays } };
}

export function contactById(c: Config, id: string): { id: string; name: string; pk?: string } | null {
  return Object.values(c.contacts ?? {}).find(x => x.id === id) ?? null;
}

export const claveContacto = (n: string) => n.toLowerCase().replace(/\s+/g, "");

export function contact(c: Config, needle: string): { id: string; name: string; pk?: string } | null {
  return c.contacts?.[claveContacto(needle)] ?? null;
}

export function save(c: Config) {
  ensureDirs();
  writeFileSync(FILE, JSON.stringify(enmascarar(c), null, 2), { mode: 0o600 });
}

/**
 * Vuelve a poner la senal en los secretos que viven en el llavero.
 *
 * Sin esto, la migracion se deshacia sola y en silencio: `load` rellenaba el secreto de
 * verdad, cualquier `save` posterior (y hay uno en casi cada operacion) lo escribia en
 * claro otra vez, y el llavero quedaba de adorno. Se decide preguntandole al llavero,
 * no recordando un estado: si ahi hay una clave para esa cuenta, en el fichero va la senal.
 */
export function enmascarar(c: Config): Config {
  if (!L.disponible()) return c;
  const copia: Config = JSON.parse(JSON.stringify(c));
  if (copia.keys?.priv && L.leer(L.CUENTAS.firma)) copia.keys.priv = L.SENAL;
  if (copia.nostr?.sk && L.leer(L.CUENTAS.nostr)) copia.nostr.sk = L.SENAL;
  if (copia.slack?.botToken && L.leer(L.CUENTAS.bot)) copia.slack.botToken = L.SENAL;
  return copia;
}

/**
 * Apunta que se ha oido a alguien. Se llama al recibir un sobre suyo, sea por donde sea.
 *
 * No es presencia en vivo: no hay ningun "estas ahi?" que mandar, y meterlo obligaria a
 * tocar el protocolo para responder a algo que la propia conversacion ya contesta. Lo
 * que se guarda es un hecho que ya tenemos: cuando llego lo ultimo suyo. `spoochie
 * contacts` lo pinta, y con eso se decide si abrir un tunel ahora o escribir por Slack.
 */
export function tocarContacto(remitente: { id?: string; npub?: string }, ahora = Date.now()) {
  const c = load();
  const x = (remitente.id ? contactById(c, remitente.id) : null) ?? (remitente.npub ? contactoPorNpub(c, remitente.npub) : null);
  if (!x) return;
  (x as { visto?: number }).visto = ahora;
  save(c);
}
