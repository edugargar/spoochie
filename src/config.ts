import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureDirs } from "./paths.ts";

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
  contacts?: Record<string, { id: string; name: string; pk?: string; npub?: string; relays?: string[] }>;
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
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
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
  writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}
