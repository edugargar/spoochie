/**
 * Puente de Slack. Es a la vez transporte entre maquinas, direccion y fuente de
 * verdad del estado: el hilo tiene quien abrio, quien acepto y las marcas de tiempo,
 * y un estado local se desincroniza en cuanto alguien cierra el portatil.
 *
 * NO usa Socket Mode. Con varias conexiones de la misma app, Slack entrega cada
 * evento a UNA sola, asi que un spoochie para Sam se lo podria quedar el demonio de
 * Edu.
 *
 * Y NO recorre tus DMs buscando spoochies. Esa fue la primera version y se cayo a la
 * primera contra una cuenta real: 197 DMs por tick, `conversations.history` es Tier 3,
 * y Slack devolvia `ratelimited` en el segundo canal. Tampoco usa `search.messages`,
 * que resolveria el problema en una llamada pero exige el scope `search:read`.
 *
 * En su lugar todo el trafico vive en el DM entre el BOT y cada persona. Ese DM es el
 * mismo canal visto desde los dos lados (verificado con un DM real), asi que cada
 * demonio consulta exactamente UN canal para lo que le llega, mas un hilo por spoochie
 * abierto. Postea y lee el bot; el token de usuario solo se usa
 * para buscar personas, que es lo unico que el bot no puede hacer.
 */
import * as Cfg from "./config.ts";
import { misClaves, firmar, verificarSobre, type Veredicto } from "./firma.ts";
import * as T from "./threads.ts";
import { VERSION, linea, masNuevaQue } from "./version.ts";
import { PLUGIN } from "./origen.ts";
import { subir, bajar } from "./files.ts";

const API = "https://slack.com/api/";
/** Cabecera legible por maquina que va en el primer mensaje del hilo. Es lo que
 *  permite al demonio del otro lado reconocer un spoochie entre sus DMs. */
/** El sobre de maquina va en `metadata` de Slack, no en el texto.
 *  Antes iba como un bloque `spoochie:v1 {...}` visible al final del mensaje: feo para
 *  quien lee, y editable por cualquiera. `metadata` vuelve intacto en history y en
 *  replies (verificado) y no se ve. */
export const EVENT = "spoochie";

export type Envelope = {
  v: 1;
  id: string;
  kind: "invite" | "msg" | "notice" | "accept" | "close" | "hola";
  /** Quien habla, por su id de Slack. Sin esto un demonio no distingue lo que postea
   *  el de enfrente de lo que ha posteado el mismo: los dos postean como el bot. */
  from: string;
  subject?: string;
  fromName?: string;
  kindOfMsg?: T.MsgKind;
  context?: unknown;
  /** Clave publica de quien firma y firma de (id, kind, from, texto). Ver firma.ts. */
  pk?: string;
  sig?: string;
  /** En el aviso que se deja en el DM del receptor: donde esta el hilo de verdad
   *  (el grupo o el canal). Sin esto, el hilo es el propio mensaje. */
  thread?: { channel: string; ts: string };
  /** La version de spoochie de quien lo manda. Sin ella, es anterior a 0.8. */
  app?: string;
  /** En un "hola": mi clave Nostr y mis reles, para que los spoochies conmigo vayan cifrados. */
  np?: string;
  r?: string[];
};

/** Slack corta cada bloque a 3000 caracteres. Trocear por lineas en vez de rebanar,
 *  que es lo que dejaba un mensaje terminado en "p" a mitad de palabra. */
export function chunk(text: string, size = 2800, max = 12): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (const piece of line.length > size ? (line.match(new RegExp(`.{1,${size}}`, "g")) ?? []) : [line]) {
      if ((cur + "\n" + piece).length > size) { if (cur) out.push(cur); cur = piece; }
      else cur = cur ? cur + "\n" + piece : piece;
    }
  }
  if (cur) out.push(cur);
  return out.length > max ? [...out.slice(0, max - 1), "_(sigue en el transcript)_"] : out;
}

/** Un id de spoochie es corto y de letras y numeros: acaba siendo nombre de fichero. */
export const ID_VALIDO = /^[A-Za-z0-9_-]{1,32}$/;

export function envelopeOf(msg: any): Envelope | null {
  const p = msg?.metadata?.event_payload;
  // El id viene de fuera y termina en join(THREADS_DIR, id + ".json"): un "../settings"
  // escribiria fuera del directorio de hilos. Sin id valido no hay sobre.
  return msg?.metadata?.event_type === EVENT && typeof p?.id === "string" && ID_VALIDO.test(p.id) && p?.from ? (p as Envelope) : null;
}

/** Un aviso del sistema, en una linea y en cristiano. */
export function noticeText(t: T.Thread, rendered: string): string {
  const who = (s: T.Side) => s.human ?? s.name;
  if (rendered.includes("ha aceptado el tunel")) {
    const quien = t.acceptedBy ?? who(t.to);
    return `:white_check_mark: ${quien} ha aceptado. El tunel esta abierto y muere solo tras 10 min de silencio.`;
  }
  if (rendered.includes("cerrado (")) {
    return `:lock: Spoochie cerrado${t.closeReason ? `: ${t.closeReason}` : ""}.`;
  }
  // Cualquier otra cosa: fuera las lineas de instrucciones internas.
  return rendered.split("\n").filter(l => !l.startsWith("spoochie ") && !l.includes("--- Esto viene")).join("\n").trim();
}

type Block = Record<string, unknown>;

const sec = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
/** Un bloque de contenido: lo que ve la persona Y lo que lee el Claude del otro lado.
 *
 *  El texto integro NO viaja en el sobre de metadata. Se probó y Slack acepta el
 *  mensaje pero se traga el sobre entero, sin error, en cuanto un valor pasa de unos
 *  3.000 caracteres. Un canal que pierde datos en silencio por encima de un umbral
 *  difuso no vale. Los bloques vuelven siempre, y ademas no hay dos copias del mismo
 *  texto que puedan discrepar. */
const BODY = "sp-body";
let bodySeq = 0;
const body = (text: string): Block => ({ type: "section", block_id: `${BODY}-${bodySeq++}-${Date.now() % 100000}`, text: { type: "mrkdwn", text } });

/** Rehace el mensaje a partir de los bloques marcados. */
export function bodyFromBlocks(blocks: any[] | undefined): string {
  return (blocks ?? [])
    .filter(b => typeof b?.block_id === "string" && b.block_id.startsWith(BODY))
    .map(b => String(b?.text?.text ?? ""))
    .join("\n")
    .replace(/^```\n?|\n?```$/g, "")
    // Slack auto-enlaza dentro del texto: <http://api.post|api.post> vuelve como tal,
    // y el otro Claude se encontraba URLs donde su companero escribio codigo.
    .replace(/<(?:https?:\/\/)?[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<((?:https?|mailto):[^>]*)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}
const ctx = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

const sideOf = (t: T.Thread, m: T.Msg) => (m.from === t.from.sessionId ? t.from : t.to);
const nameOf = (s: T.Side) => s.human ?? s.name;

function contextLine(t: T.Thread): string | null {
  const c = t.context;
  const bits = [
    c.branch ? `\`${c.branch}\`` : null,
    c.sha ? `\`${c.sha.slice(0, 7)}\`` : null,
    c.files?.length ? c.files.map(f => `\`${f}\``).join("  ") : null,
  ].filter(Boolean);
  return bits.length ? bits.join("  ·  ") : null;
}

/** La apertura, tal y como la ve la persona. El sobre de maquina va aparte. */
export function inviteBlocks(t: T.Thread): Block[] {
  const c = contextLine(t);
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `Spoochie de ${nameOf(t.from)}`.slice(0, 150), emoji: true } },
    sec(`*${t.subject}*`),
  ];
  if (c) blocks.push(ctx(c));
  for (const c of chunk(t.messages[0]?.text ?? "")) blocks.push(body(c));
  blocks.push({ type: "divider" });
  blocks.push(sec(`<@${t.to.slackUser}> contesta en este hilo para aceptarlo, o dile a tu Claude:\n\`spoochie accept ${t.id}\``));
  blocks.push(ctx("Caduca sin aceptar en 4 h  ·  una vez abierto, muere tras 10 min de silencio"));
  return blocks;
}

/** Un turno. El autor va arriba en pequeno, el contenido debajo. */
export function messageBlocks(t: T.Thread, m: T.Msg): Block[] {
  const who = nameOf(sideOf(t, m));
  const head = m.author === "human" ? `*${who}* · escribe en persona` : `*${who}* · su Claude`;
  const blocks: Block[] = [ctx(head)];

  if (m.kind === "patch") {
    blocks.push(sec("Parche propuesto. Aplícalo tú si te convence, nadie escribe en tu máquina."));
    for (const c of chunk(m.text, 2700, Math.ceil(T.MAX_PARCHE / 2700))) blocks.push(body("```\n" + c + "\n```"));
  } else if (m.kind === "branch") {
    blocks.push(body(`Rama para revisar: \`${m.text}\``));
  } else {
    for (const c of chunk(m.text)) blocks.push(body(c));
  }

  if (m.files?.length) blocks.push(ctx(m.files.map(f => `\`${f}\``).join("  ")));
  if (m.offTopic && m.offTopic.verdict !== "dentro") {
    blocks.push(ctx(`:warning: el vigilante lo ve *${m.offTopic.verdict}* del asunto: ${m.offTopic.why}`));
  }
  return blocks;
}

/** Un aviso del sistema: una línea pequeña, nunca el texto interno que va al Claude. */
export function noticeBlocks(t: T.Thread, rendered: string): { blocks: Block[]; text: string } {
  let text: string;
  if (rendered.includes("ha aceptado el tunel")) {
    text = `:white_check_mark: *${t.acceptedBy ?? nameOf(t.to)}* ha aceptado. El túnel está abierto.`;
  } else if (rendered.includes("cerrado (")) {
    text = `:lock: Cerrado${t.closeReason ? ` · ${t.closeReason}` : ""}`;
  } else {
    text = rendered.split("\n").filter(l => !l.startsWith("spoochie ") && !l.includes("--- Esto viene")).join("\n").trim();
  }
  return { blocks: [ctx(text)], text };
}

/** Un acuse a secas: aceptar, vale, ok. No es un turno de conversacion. */
const ACUSES = /^(acepto|aceptado|vale|ok|okey|oki|dale|si|sí|venga|adelante|perfecto|genial|gracias|👍|✅)[\s.!]*$/i;
export const esAcuse = (t: string) => ACUSES.test(t.trim());
/** Por debajo de esto, lo que el receptor escribe estando pendiente es solo "acepto". */
export const ACEPTAR_A_SECAS = 60;

/** Texto plano de respaldo: es lo que sale en la notificación del móvil. */
export function fallbackText(t: T.Thread, m: T.Msg): string {
  const who = nameOf(sideOf(t, m));
  if (m.kind === "patch") return `${who} te manda un parche`;
  if (m.kind === "branch") return `${who}: rama ${m.text}`;
  return `${who}: ${m.text.slice(0, 180)}`;
}

/** auth.test devuelve quien eres con ese token. Asi el setup no te pide el user id. */
export async function whoIs(token: string): Promise<{ userId: string; user: string; team: string } | null> {
  try {
    const res = await fetch(API + "auth.test", { headers: { authorization: `Bearer ${token}` } });
    const j = await res.json();
    return j.ok ? { userId: j.user_id, user: j.user, team: j.team } : null;
  } catch { return null; }
}

type OnMessage = (t: T.Thread, m: T.Msg) => Promise<void>;
type OnAccept = (t: T.Thread, como: string) => Promise<void>;
type OnRemoteAccept = (t: T.Thread, como: string) => Promise<void>;
type OnOrden = (t: T.Thread, orden: "suelta" | "descarta") => Promise<void>;
type OnCierre = (t: T.Thread, motivo: string) => Promise<void>;

/**
 * Cada cuanto mira el buzon un demonio, segun cuantos demonios comparten la app.
 *
 * `conversations.history` es Tier 3: unas 50 llamadas por minuto para toda la app. La
 * mitad, 25, se reparte entre los demonios para descubrir spoochies nuevos; la otra
 * mitad queda para el que acaba de abrir uno y para no ir al limite. Con 2 personas
 * salen 12 al minuto cada uno, que es el suelo de 5 s; con 4, 10 s; con 15, 36 s; con
 * 25, 60 s. El equipo son los contactos de la agenda mas uno. Si Slack devuelve 429
 * igualmente, el demonio se congela lo que Slack le diga (ver `frozen`).
 */
export function cadenciaDescubrir(equipo: number, sueloMs = 5_000): number {
  return Math.max(sueloMs, Math.round(Math.max(1, equipo) * 60_000 / 25));
}

export class SlackBridge {

  private lastDiscovery = 0;

  private botUserId: string | null = null;
  private holasVistos = new Set<string>();
  /** El otro lado cerro el spoochie. */
  onCierre: OnCierre | null = null;
  private myDm: string | null = null;
  /** Al arrancar se mira atras lo mismo que dura la cola de pendientes: un spoochie
   *  mas viejo que eso ya ha caducado, y uno de hace un minuto tiene que aparecer
   *  aunque el demonio se haya levantado despues. */
  private inboxCursor = String(Math.round((Date.now() - T.PENDING_TTL_MS) / 1000));
  /** Cuando Slack dice basta, se para hasta esta marca. */
  private backoffUntil = 0;
  /** El aviso de "esta mirando" que hay puesto en cada hilo, para poder quitarlo. */
  private pensando = new Map<string, { ts: string; desde: number }>();
  /** Si el otro lado no contesta, el aviso de "esta mirando" se quita solo.
   *  Un indicador eterno miente igual que un silencio. */
  private static PENSANDO_MAX_MS = 4 * 60 * 1000;

  private constructor(
    /** Vacio si la app tiene users:read de bot. Solo sirve para buscar personas:
     *  el trafico lo mueve siempre el bot. Sin el, uno menos que pedirle a nadie. */
    private userToken: string,
    private botToken: string,
    private me: string,
    private onMessage: OnMessage,
    private onAccept: OnAccept,
    private onRemoteAccept: OnRemoteAccept,
    private onOrden?: OnOrden,
  ) {}

  static fromConfig(onMessage: OnMessage, onAccept: OnAccept, onRemoteAccept: OnRemoteAccept, onOrden?: OnOrden, onCierre?: OnCierre): SlackBridge | null {
    const c = Cfg.load();
    const user = Cfg.slackToken(c);
    const bot = Cfg.slackBotToken(c);
    // El token de usuario ya no hace falta: si la app tiene users:read de bot, el
    // bot busca personas igual de bien. Lo que no se puede pedir a nadie es un token
    // que solo se consigue instalando la app uno mismo.
    if (!bot || !c.slack?.userId) return null;
    const b = new SlackBridge(user ?? "", bot, c.slack.userId, onMessage, onAccept, onRemoteAccept, onOrden);
    b.onCierre = onCierre ?? null;
    return b;
  }

  /** Un 429 no se reintenta al momento: se respeta Retry-After y se para todo.
   *  Insistir contra un rate limit es como te lo amplian. */
  private noteLimit(res: Response) {
    const wait = Number(res.headers.get("retry-after") ?? 30);
    this.backoffUntil = Date.now() + (Number.isFinite(wait) ? wait : 30) * 1000;
  }

  private get frozen() { return Date.now() < this.backoffUntil; }

  private async call(method: string, body: Record<string, unknown>, as: "bot" | "user" = "bot"): Promise<any> {
    if (this.frozen) throw new Error("slack en espera por rate limit");
    const res = await fetch(API + method, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${as === "bot" ? this.botToken : this.userToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { this.noteLimit(res); throw new Error(`slack ${method}: ratelimited`); }
    const json = await res.json();
    if (!json.ok) {
      if (json.error === "ratelimited") this.backoffUntil = Date.now() + 30_000;
      throw new Error(`slack ${method}: ${json.error}`);
    }
    return json;
  }

  private async get(method: string, params: Record<string, string>, as: "bot" | "user" = "bot"): Promise<any> {
    if (this.frozen) throw new Error("slack en espera por rate limit");
    const res = await fetch(`${API}${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${as === "bot" ? this.botToken : this.userToken}` },
    });
    if (res.status === 429) { this.noteLimit(res); throw new Error(`slack ${method}: ratelimited`); }
    const json = await res.json();
    if (!json.ok) {
      if (json.error === "ratelimited") this.backoffUntil = Date.now() + 30_000;
      throw new Error(`slack ${method}: ${json.error}`);
    }
    return json;
  }

  private team: string | null = null;
  /** El id del workspace, para los enlaces slack:// del dialogo de aviso. */
  async teamId(): Promise<string | null> {
    if (this.team) return this.team;
    try { this.team = (await this.get("auth.test", {})).team_id ?? null; } catch { this.team = null; }
    return this.team;
  }

  /** Que version corre el otro lado. Si es una linea anterior a la mia, se dice UNA vez
   *  en el hilo: hasta ahora la unica pista era que algo no funcionaba. Solo avisa el
   *  lado mas nuevo, para no decirlo dos veces. */
  private async notarVersion(t: T.Thread, env: Envelope) {
    const otra = env.app ?? "0.7.1";
    const fresco = T.load(t.id) ?? t;
    if (fresco.versionOtro !== otra) { fresco.versionOtro = otra; T.save(fresco); }
    if (fresco.avisoVersion || linea(otra) === linea(VERSION) || !masNuevaQue(VERSION, otra) || !fresco.slack) return;
    fresco.avisoVersion = true;
    T.save(fresco);
    const quien = env.from === fresco.from.slackUser ? (fresco.from.human ?? fresco.from.name) : (fresco.to.human ?? fresco.to.name);
    await this.aviso(fresco, `:information_source: ${quien} tiene spoochie ${otra} y aqui hay ${VERSION}. Puede que algo no le funcione igual: \`/plugin update ${PLUGIN}\` y reiniciar una sesion.`);
  }

  /** El DM entre el bot y yo: el unico canal que hay que mirar para lo que me llega. */
  private async inbox(): Promise<string | null> {
    if (this.myDm) return this.myDm;
    try {
      if (!this.botUserId) this.botUserId = (await this.get("auth.test", {})).user_id;
      const im = await this.call("conversations.open", { users: this.me });
      this.myDm = im.channel.id;
      return this.myDm;
    } catch { return null; }
  }

  /** Quien pregunta por las personas. El bot si la app tiene users:read; si no, el
   *  token de usuario de quien lo tenga. Buscar es lo unico que necesita esto. */
  private quienBusca(): "bot" | "user" { return this.userToken ? "user" : "bot"; }

  async lookupUser(needle: string): Promise<SlackUser | null> {
    // Un id de Slack se acepta tal cual: es lo unico que no puede ser ambiguo.
    if (/^[UWB][A-Z0-9]{6,}$/.test(needle)) {
      try {
        const r = await this.get("users.info", { user: needle }, this.quienBusca());
        return { id: needle, name: r.user?.profile?.real_name ?? r.user?.name ?? needle };
      } catch { return { id: needle, name: needle }; }
    }
    if (needle.includes("@")) {
      try {
        const r = await this.get("users.lookupByEmail", { email: needle }, this.quienBusca());
        return { id: r.user.id, name: r.user.profile?.real_name ?? r.user.name };
      } catch { return null; }
    }
    const r = await this.get("users.list", { limit: "500" }, this.quienBusca());
    const n = needle.toLowerCase();
    const hit = (r.members ?? []).find((u: any) =>
      !u.deleted && !u.is_bot &&
      [u.name, u.profile?.display_name, u.profile?.real_name].filter(Boolean)
        .some((x: string) => x.toLowerCase() === n || x.toLowerCase().replace(/\s+/g, "") === n));
    return hit ? { id: hit.id, name: hit.profile?.real_name ?? hit.name } : null;
  }

  /** Donde va a vivir el hilo de un spoochie que abro yo.
   *
   *  Con el hilo en el DM entre el bot y quien recibe, quien abre no lo veia en Slack:
   *  Edu le abrio uno a Sam y solo Sam tenia la conversacion delante. Ahora, por
   *  defecto, el hilo va a un grupo de mensajes directos bot + yo + la otra persona,
   *  que vemos los dos. El DM del receptor con el bot sigue recibiendo un aviso con la
   *  invitacion entera, porque es el unico canal que su demonio vigila; ese aviso lleva
   *  en el sobre donde esta el hilo de verdad. Si la app no tiene mpim:write, el
   *  grupo no se puede abrir y el hilo se queda en el DM, como antes. */
  private async hogar(t: T.Thread, dm: string): Promise<{ channel: string; tipo: "grupo" | "canal" | "dm" }> {
    const c = Cfg.load().slack;
    const modo = c?.hilos ?? "grupo";
    if (modo === "canal" && c?.canal) return { channel: c.canal, tipo: "canal" };
    if (modo === "grupo") {
      try {
        const g = await this.call("conversations.open", { users: `${this.me},${t.to.slackUser}` });
        if (g?.channel?.id) return { channel: g.channel.id, tipo: "grupo" };
      } catch (e) {
        if (!this.avisadoSinGrupo) { this.avisadoSinGrupo = true; console.error(`spoochie: no puedo abrir el grupo bot+tu+${t.to.human ?? t.to.name} (${String(e).replace(/^Error: /, "")}); el hilo va al DM del receptor. Anade mpim:write, mpim:read y mpim:history a la app de Slack.`); }
      }
    }
    return { channel: dm, tipo: "dm" };
  }
  private avisadoSinGrupo = false;

  async openThread(t: T.Thread): Promise<{ channel: string; ts: string } | null> {
    // El DM entre el bot y quien recibe: el canal que su demonio vigila.
    const im = await this.call("conversations.open", { users: t.to.slackUser });
    const dm: string = im.channel.id;
    const { channel, tipo } = await this.hogar(t, dm);
    let aviso: { channel: string; ts: string } | undefined;
    const env: Envelope = {
      v: 1, id: t.id, kind: "invite", from: t.from.slackUser ?? this.me,
      subject: t.subject, fromName: t.from.human ?? t.from.name, context: t.context,
    };
    this.firma(env, t.messages[0]?.text ?? "");
    const post = await this.call("chat.postMessage", {
      channel,
      text: `Spoochie de ${t.from.human ?? t.from.name}: ${t.subject}`,
      blocks: inviteBlocks(t),
      metadata: { event_type: EVENT, event_payload: env },
      unfurl_links: false,
    });
    if (tipo !== "dm") {
      // El aviso en el DM del receptor: la misma invitacion, con el sobre apuntando al
      // hilo de verdad, y un enlace para la persona.
      let enlace = tipo === "grupo" ? "vuestro grupo con el bot" : "el canal de spoochie";
      try { const p = await this.call("chat.getPermalink", { channel, message_ts: post.ts }); if (p?.permalink) enlace = `<${p.permalink}|${enlace}>`; } catch {}
      const av = await this.call("chat.postMessage", {
        channel: dm,
        text: `Spoochie de ${t.from.human ?? t.from.name}: ${t.subject}`,
        blocks: [...inviteBlocks(t), ctx(`La conversacion sigue en ${enlace}, donde la veis los dos.`)],
        metadata: { event_type: EVENT, event_payload: { ...env, thread: { channel, ts: post.ts } } },
        unfurl_links: false,
      });
      aviso = { channel: dm, ts: av.ts };
    }
    // Los ficheros del primer mensaje se suben al hilo recien creado. Antes solo los
    // subia post(), asi que una captura adjunta al abrir se quedaba en la maquina.
    for (const f of t.messages[0]?.files ?? []) {
      await subir(this.botToken, f, channel, post.ts);
    }
    return { channel, ts: post.ts, ...(aviso ? { aviso } : {}) };
  }

  /** Le mando a una persona mi clave Nostr por su DM con el bot. Asi quien ya estaba en
   *  spoochie por Slack pasa a Nostr sin volver a darse de alta: su demonio la guarda
   *  en la agenda y contesta con la suya. */
  async hola(userId: string, np: string, r: string[], nombre: string): Promise<boolean> {
    try {
      const im = await this.call("conversations.open", { users: userId });
      await this.call("chat.postMessage", {
        channel: im.channel.id, text: `${nombre} ya puede hablar contigo por Nostr (cifrado, sin pasar por Slack).`,
        blocks: [ctx(`:key: ${nombre} ya puede hablar contigo por Nostr: los spoochies entre vosotros iran cifrados y no pasaran por Slack. Slack seguira avisandote.`)],
        // Firmado con mi clave ed25519 (la que ya tienen fijada de mis sobres): sin
        // firma, cualquiera con el token del bot podia poner una clave a mi nombre.
        metadata: { event_type: EVENT, event_payload: { v: 1, id: "hola", kind: "hola", from: this.me, fromName: nombre, np, r, app: VERSION, pk: misClaves(Cfg.load()).pub, sig: firmar(misClaves(Cfg.load()).priv, "hola", "hola", this.me, np) } },
      });
      return true;
    } catch { return false; }
  }
  /** Al recibir un hola por Slack. */
  onHola: ((de: string, nombre: string, np: string, r: string[], veredicto: Veredicto) => Promise<void>) | null = null;

  /** Un aviso a una persona por su DM con el bot, sin sobre: el hilo vive en otro sitio. */
  async avisarDm(userId: string, texto: string): Promise<boolean> {
    try {
      const im = await this.call("conversations.open", { users: userId });
      await this.call("chat.postMessage", { channel: im.channel.id, text: texto, blocks: [ctx(texto)], metadata: { event_type: EVENT, event_payload: { v: 1, id: "aviso", kind: "notice", from: this.me } } });
      return true;
    } catch { return false; }
  }

  /**
   * Borra en Slack todo lo que posteo el bot de este spoochie: el hilo entero (raiz y
   * respuestas del bot), los ficheros que subio, y el aviso del DM del receptor. Lo que
   * escribio una persona a mano no lo puede borrar el bot; se queda, sin contexto.
   * Devuelve cuantos mensajes se borraron. Los dos demonios lo intentan: es idempotente.
   */
  async borrarHilo(t: T.Thread): Promise<number> {
    if (!t.slack) return 0;
    let n = 0;
    const borrar = async (channel: string, ts: string) => { try { await this.call("chat.delete", { channel, ts }); n++; } catch {} };
    let reps: any[] = [];
    try { reps = (await this.get("conversations.replies", { channel: t.slack.channel, ts: t.slack.ts, limit: "200" })).messages ?? []; } catch {}
    for (const r of reps) {
      if (r.ts === t.slack.ts) continue;
      if (!r.bot_id && !(this.botUserId && r.user === this.botUserId)) continue;
      for (const f of r.files ?? []) { try { await this.call("files.delete", { file: f.id }); } catch {} }
      await borrar(t.slack.channel, r.ts);
    }
    const raiz = reps.find(r => r.ts === t.slack!.ts);
    if (!raiz || raiz.bot_id || (this.botUserId && raiz.user === this.botUserId)) await borrar(t.slack.channel, t.slack.ts);
    if (t.slack.aviso) await borrar(t.slack.aviso.channel, t.slack.aviso.ts);
    return n;
  }

  async post(t: T.Thread, notice: string, m?: T.Msg): Promise<boolean> {
    if (!t.slack) return false;
    await this.pensandoOff(t);
    const mine = t.from.slackUser === this.me ? t.from : t.to;
    const env: Envelope = {
      v: 1, id: t.id,
      kind: m ? "msg" : notice.includes("ha aceptado el tunel") ? "accept" : notice.includes("cerrado (") ? "close" : "notice",
      from: mine.slackUser ?? this.me,
      ...(m ? { kindOfMsg: m.kind } : {}),
    };
    if (m) this.firma(env, m.text);
    const body = m
      ? { text: fallbackText(t, m), blocks: messageBlocks(t, m) }
      : noticeBlocks(t, notice);
    // Los ficheros van al hilo antes que el texto, para que se lean juntos.
    if (m?.files?.length) {
      for (const f of m.files) await subir(this.botToken, f, t.slack.channel, t.slack.ts);
    }
    try {
      await this.call("chat.postMessage", {
        channel: t.slack.channel, thread_ts: t.slack.ts,
        ...body,
        metadata: { event_type: EVENT, event_payload: env },
        unfurl_links: false,
      });
      return true;
    } catch { return false; }
  }

  /**
   * Un aviso de que el otro lado esta trabajando. Sin esto hay 30 o 40 segundos de
   * pantalla en blanco en los que nadie sabe si el tunel se ha muerto.
   * Se pone al entregar un turno y se quita en cuanto llega la respuesta.
   */
  async pensandoOn(t: T.Thread, quien: string) {
    if (!t.slack || this.pensando.has(t.id)) return;
    try {
      const r = await this.call("chat.postMessage", {
        channel: t.slack.channel, thread_ts: t.slack.ts,
        text: `${quien} está mirando su código…`,
        blocks: [ctx(`:hourglass_flowing_sand: _${quien} está mirando su código…_`)],
        // Sin sobre, el demonio del otro lado se lo tragaba como si fuera una persona
        // escribiendo, y su Claude recibia "Sam esta mirando su codigo" como un turno.
        metadata: { event_type: EVENT, event_payload: { v: 1, id: t.id, kind: "notice", from: this.me } },
      });
      this.pensando.set(t.id, { ts: r.ts, desde: Date.now() });
    } catch {}
  }

  async pensandoOff(t: T.Thread) {
    const p = this.pensando.get(t.id);
    if (!p || !t.slack) return;
    this.pensando.delete(t.id);
    try { await this.call("chat.delete", { channel: t.slack.channel, ts: p.ts }); } catch {}
  }

  /** Barre los indicadores que llevan demasiado puestos. */
  private async barrerPensando() {
    for (const [id, p] of [...this.pensando]) {
      if (Date.now() - p.desde < SlackBridge.PENSANDO_MAX_MS) continue;
      const t = T.load(id);
      this.pensando.delete(id);
      if (t?.slack) { try { await this.call("chat.delete", { channel: t.slack.channel, ts: p.ts }); } catch {} }
    }
  }

  /**
   * Presupuesto de llamadas.
   *
   * `conversations.replies` y `conversations.history` son Tier 3: del orden de 50 por
   * minuto y por metodo, contadas **por app**, no por persona. Como todo el equipo
   * comparte la misma app, el gasto de todos se suma en el mismo cubo. Mi primer
   * intento (6 hilos cada 4s) daban 105 llamadas por minuto y por demonio: por catorce
   * personas, ni de lejos.
   *
   * El descubrimiento (history) se reparte por cadenciaDescubrir: 25 llamadas por
   * minuto entre todos los demonios, sean 2 o 25, con un suelo de 5 s por demonio. Los
   * hilos vivos (replies) van a 12/min por demonio con conversacion, como mucho 4
   * hilos por tic. Para 15 personas con dos conversaciones vivas: 25 de history y 24 de
   * replies por minuto, con el limite en 50 de cada uno.
   */
  private static TOPE_HILOS = 4;
  private static RECIENTE_MS = 2 * 60 * 1000;
  private rueda = 0;
  private ultimaMirada = new Map<string, number>();
  private ultimoDescubrir = 0;

  /** Lo que gasta este demonio ahora mismo, para poder decirlo en `spoochie doctor`. */
  presupuesto(): { hilos: number; historyPorMin: number; repliesPorMin: number } {
    const vivos = T.all().filter(t => t.state !== "closed" && t.slack).length;
    const cadencia = cadenciaDescubrir(Object.keys(Cfg.load().contacts ?? {}).length + 1);
    return {
      hilos: vivos,
      historyPorMin: Math.round(60_000 / cadencia),
      repliesPorMin: Math.min(vivos, SlackBridge.TOPE_HILOS) * 12,
    };
  }

  async poll(): Promise<void> {
    if (this.frozen) return;
    const ahora = Date.now();
    const abiertos = T.all().filter(t => t.state !== "closed" && t.slack);

    // Solo corre detras del hilo que se ha movido hace poco. Uno abierto pero parado
    // entra por turnos, para que ninguno se quede sin mirar y ninguno acapare.
    const recientes = abiertos.filter(t => ahora - t.lastActivityAt < SlackBridge.RECIENTE_MS);
    const parados = abiertos.filter(t => ahora - t.lastActivityAt >= SlackBridge.RECIENTE_MS);
    const cola = [...recientes];
    for (let i = 0; i < parados.length && cola.length < SlackBridge.TOPE_HILOS; i++) {
      cola.push(parados[(this.rueda + i) % parados.length]);
    }
    this.rueda = (this.rueda + 1) % Math.max(parados.length, 1);

    for (const t of cola.slice(0, SlackBridge.TOPE_HILOS)) {
      this.ultimaMirada.set(t.id, ahora);
      await this.pollThread(t);
      if (this.frozen) return;
    }

    // El buzon se mira tan a menudo como el cupo compartido permita al equipo que hay.
    const cadencia = cadenciaDescubrir(Object.keys(Cfg.load().contacts ?? {}).length + 1);
    if (ahora - this.ultimoDescubrir >= cadencia) {
      this.ultimoDescubrir = ahora;
      await this.discover();
    }
    await this.barrerPensando();
  }

  private async pollThread(t: T.Thread) {
    const oldest = t.slackCursor ?? t.slack!.ts;
    let r: any;
    try {
      r = await this.get("conversations.replies", {
        channel: t.slack!.channel, ts: t.slack!.ts, oldest, limit: "50", include_all_metadata: "true",
      });
    } catch { return; }

    for (const rep of (r.messages ?? []) as Reply[]) {
      if (rep.ts === t.slack!.ts || rep.ts <= oldest) continue;
      // El cursor se guarda antes de entregar: si algo peta a mitad, se pierde un
      // mensaje, que es mejor que reinyectar el hilo entero en bucle.
      const vivo = T.load(t.id);
      if (vivo) { vivo.slackCursor = rep.ts; T.save(vivo); t.slackCursor = rep.ts; }

      // Ficheros compartidos en el hilo: se bajan al spool y se anuncian con su ruta
      // local, que es lo unico que el Claude de esta maquina puede abrir.
      const suyos = (rep as any).files as any[] | undefined;
      if (suyos?.length && rep.user !== this.me) {
        const rutas = await bajar(this.botToken, suyos, t.id);
        if (rutas.length) {
          await this.onMessage(t, {
            at: Math.round(Number(rep.ts) * 1000),
            from: T.otherSide(t, this.localSideId(t)).sessionId,
            author: "claude", kind: "text",
            text: `Te dejo ${rutas.length === 1 ? "un fichero" : `${rutas.length} ficheros`} en el hilo. Ya estan bajados en esta maquina, abrelos si quieres.`,
            files: rutas,
          });
        }
      }
      if (rep.subtype === "file_share" && !(rep.text ?? "").trim()) continue;
      if (rep.subtype && rep.subtype !== "file_share") continue;

      const env = envelopeOf(rep);
      if (env) await this.notarVersion(t, env);
      if (env) {
        // Lo postea spoochie. Los dos lados postean como el bot, asi que quien habla
        // solo se sabe por el sobre. Sin esto un demonio se salta al otro.
        if (env.from === this.me) continue;
        if (env.kind === "accept") { await this.onRemoteAccept(t, "en la otra maquina"); continue; }
        // El cierre del otro lado: antes era un aviso mas y se ignoraba, y este lado
        // se enteraba por silencio a los 10 min. Ahora cierra (y borra) aqui tambien.
        if (env.kind === "close") { if (this.onCierre) await this.onCierre(t, /cerrado \(([^)]*)\)/.exec(rep.text ?? "")?.[1] ?? "cerrado por el otro lado"); continue; }
        if (env.kind === "notice" || env.kind === "invite") continue;
        const texto = bodyFromBlocks((rep as any).blocks) || rep.text || "";
        const firma = verificarSobre(env, texto);
        if (firma === "mala") {
          // No se entrega. Se dice en el hilo, que es donde lo ven las personas.
          await this.aviso(t, `:no_entry: un mensaje que decia venir de ${env.fromName ?? env.from} llevaba una firma que no es suya. Descartado.`);
          continue;
        }
        await this.onMessage(t, {
          at: Math.round(Number(rep.ts) * 1000),
          from: T.otherSide(t, this.localSideId(t)).sessionId,
          author: "claude",
          kind: env.kindOfMsg ?? "text",
          text: texto,
          firma,
        });
        continue;
      }

      // Sin sobre: lo ha escrito una persona a mano en Slack.
      const texto = (rep.text ?? "").trim();
      const esMio = rep.user === this.me;
      // En un grupo escriben los dos. Mientras el tunel esta pendiente, solo quien recibe
      // puede abrirlo escribiendo: lo que diga la otra persona antes de eso no cuenta.
      if (t.state === "pending" && rep.user !== t.to.slackUser) continue;

      // Yo soy quien recibe y escribo en el hilo estando pendiente: eso ES aceptar.
      // Antes mi propio demonio se saltaba mis mensajes y el tunel no se abria nunca
      // desde Slack, mientras el demonio del otro lado si me reenviaba el "acepto".
      // Y lo que escribo ahi no es un turno de conversacion salvo que sea largo: en e856
      // un "aceptarlo" se reenvio a la otra persona como si fuera un mensaje.
      if (esMio && t.to.slackUser === this.me && t.state === "pending") {
        await this.onAccept(t, "en Slack");
        if (esAcuse(texto) || texto.length < ACEPTAR_A_SECAS) continue;
      }
      // "suelta" / "descarta" del receptor sobre lo que el vigilante retuvo.
      if (esMio && this.onOrden && /^(suelta|libera|entrega|release)[\s.!]*$/i.test(texto)) { await this.onOrden(t, "suelta"); continue; }
      if (esMio && this.onOrden && /^(descarta|tira|discard)[\s.!]*$/i.test(texto)) { await this.onOrden(t, "descarta"); continue; }
      // Mis propios mensajes no vuelven a mi propia sesion.
      if (esMio) continue;
      // Un "acepto" a secas no es un turno: reenviarlo solo consigue que el Claude
      // de enfrente conteste "con un acepto no me llega".
      if (esAcuse(texto)) continue;
      // Un mensaje vacio no se entrega. Pasaba con los adjuntos sin texto: al otro
      // lado le llegaba "Fulano (humano, en persona):" y nada mas debajo.
      if (!texto) continue;
      await this.onMessage(t, {
        at: Math.round(Number(rep.ts) * 1000),
        from: T.otherSide(t, this.localSideId(t)).sessionId,
        author: "human", kind: "text", text: texto,
      });
    }
  }

  /** Un aviso de spoochie en el hilo, con sobre para que ningun demonio lo tome por una persona. */
  async aviso(t: T.Thread, texto: string) {
    if (!t.slack) return;
    await this.avisoEn(t.slack.channel, t.slack.ts, texto);
  }
  private async avisoEn(channel: string, thread_ts: string, texto: string) {
    try {
      await this.call("chat.postMessage", {
        channel, thread_ts, text: texto, blocks: [ctx(texto)],
        metadata: { event_type: EVENT, event_payload: { v: 1, id: "aviso", kind: "notice", from: this.me } },
      });
    } catch {}
  }

  /** Firma el sobre con mis claves. Si no hay claves (config de antes del alta con
   *  firma), el sobre sale sin firmar y el otro lado lo vera marcado. */
  private firma(env: Envelope, text: string) {
    env.app = VERSION;
    const c = Cfg.load();
    if (!c.slack) return;
    const k = misClaves(c);
    env.pk = k.pub;
    env.sig = firmar(k.priv, env.id, env.kind, env.from, text);
  }

  /** Cual de los dos lados soy yo en este hilo. */
  private localSideId(t: T.Thread): string {
    return t.to.slackUser === this.me ? t.to.sessionId : t.from.sessionId;
  }

  /** Descubre spoochies que me han abierto. Una sola llamada, a un solo canal. */
  private async discover() {
    const ch = await this.inbox();
    if (!ch) return;
    let hist: any;
    try {
      hist = await this.get("conversations.history", {
        channel: ch, oldest: this.inboxCursor, limit: "20", include_all_metadata: "true",
      });
    } catch { return; }
    const known = new Set(T.all().map(t => t.id));
    for (const msg of (hist.messages ?? []).slice().reverse()) {
      if (msg.ts > this.inboxCursor) this.inboxCursor = msg.ts;
      const env = envelopeOf(msg);
      if (env?.kind === "hola" && env.from !== this.me && env.np && /^[0-9a-f]{64}$/.test(env.np) && !this.holasVistos.has(msg.ts)) {
        this.holasVistos.add(msg.ts);
        if (this.onHola) await this.onHola(env.from, env.fromName ?? env.from, env.np, Array.isArray(env.r) ? env.r : [], verificarSobre({ id: "hola", kind: "hola", from: env.from, fromName: env.fromName, pk: env.pk, sig: env.sig }, env.np));
        continue;
      }
      if (!env || env.kind !== "invite" || known.has(env.id) || env.from === this.me) continue;
      if (verificarSobre(env, bodyFromBlocks(msg.blocks)) === "mala") {
        known.add(env.id);
        await this.avisoEn(ch, msg.thread_ts ?? msg.ts, `:no_entry: esta invitacion dice venir de ${env.fromName ?? env.from} pero la firma no es suya. Descartada.`);
        continue;
      }
      // Un spoochie que esta maquina ya conocio no vuelve, aunque se borre el estado.
      if (T.yaVisto(env.id)) continue;
      // El aviso del DM puede apuntar al hilo de verdad (un grupo o un canal).
      await this.materialize(env, env.thread?.channel ?? ch, env.thread?.ts ?? msg.thread_ts ?? msg.ts, bodyFromBlocks(msg.blocks));
    }
  }

  /** Crea el hilo local de un spoochie que me llega de otra maquina. Queda
   *  pendiente hasta que mi humano acepte: la invitacion la entrega el demonio
   *  a la sesion local que encaje, o al registrarse la siguiente. */
  private async materialize(env: Envelope, channel: string, ts: string, cuerpo = "") {
    const now = Date.now();
    const t: T.Thread = {
      id: env.id,
      subject: env.subject ?? "(sin asunto)",
      from: { sessionId: `slack:${env.from}`, name: env.fromName ?? "remoto", cwd: "(otra maquina)", human: env.fromName, slackUser: env.from },
      to: { sessionId: `slack:${this.me}`, name: "yo", cwd: "(esta maquina)", slackUser: this.me },
      state: "pending",
      createdAt: now,
      lastActivityAt: now,
      context: (env.context as T.Thread["context"]) ?? {},
      slack: { channel, ts },
      messages: [],
    };
    T.save(t);
    await this.onMessage(t, {
      at: now, from: t.from.sessionId, author: "claude", kind: "text",
      text: cuerpo || "(el mensaje de apertura llego vacio)",
    });
  }
}
