/**
 * The Slack bridge. It is at once the transport between machines, the address book and
 * the source of truth for state: the thread knows who opened, who accepted and when, and
 * local state drifts the moment someone closes their laptop.
 *
 * It does NOT use Socket Mode. With several connections from the same app, Slack
 * delivers each event to ONE of them, so a spoochie for Sam could end up in Edu's
 * daemon.
 *
 * And it does NOT walk your DMs looking for spoochies. That was the first version and it
 * fell over on first contact with a real account: 197 DMs per tick,
 * `conversations.history` is Tier 3, and Slack returned `ratelimited` on the second
 * channel. It does not use `search.messages` either, which would solve it in one call
 * but needs the `search:read` scope.
 *
 * Instead all traffic lives in the DM between the BOT and each person. That DM is the
 * same channel seen from both sides (checked with a real DM), so each daemon polls
 * exactly ONE channel for what comes in, plus one thread per open spoochie. The bot
 * posts and reads; the user token is only used to look people up, which is the one
 * thing the bot cannot do.
 */
import * as Cfg from "./config.ts";
import { myKeys, makeSignature, verifyEnvelope, type Verdict } from "./signing.ts";
import * as T from "./threads.ts";
import { VERSION, versionLine, newerThan } from "./version.ts";
import { PLUGIN } from "./origin.ts";
import { upload, download } from "./files.ts";
import { PROTOCOL, readVersion } from "./protocol.ts";

const API = "https://slack.com/api/";
/** Machine-readable header on the thread's first message. It is what lets the daemon
 *  on the other side spot a spoochie among its DMs. */
/** The machine envelope goes in Slack's `metadata`, not in the text.
 *  It used to be a visible `spoochie:v1 {...}` block at the end of the message: ugly for
 *  the reader, and anyone could edit it. `metadata` comes back intact in history and in
 *  replies (checked) and is not shown. */
export const EVENT = "spoochie";

export type Envelope = {
  v: number;
  id: string;
  kind: "invite" | "msg" | "notice" | "accept" | "close" | "hola" | "rota";
  /** Who is speaking, by Slack id. Without this a daemon cannot tell what the other side
   *  posted from what it posted itself: both post as the bot. */
  from: string;
  subject?: string;
  fromName?: string;
  kindOfMsg?: T.MsgKind;
  context?: unknown;
  /** Who it is for, by Slack id. It is covered by the signature: without it, a properly
   *  signed envelope could be replayed into someone else's thread. Empty in a "hola". */
  to?: string;
  /** When it was signed, in seconds. It is covered by the signature: without it, a saved
   *  envelope could be released again months later and still be valid. */
  ts?: number;
  /** Signature version. 2 since 0.9.9; missing in older envelopes. */
  sv?: number;
  /** The signer's public key, and the signature over everything above plus the text. See signing.ts. */
  pk?: string;
  sig?: string;
  /** On the notice left in the receiver's DM: where the real thread is (the group or
   *  the channel). Without it, the thread is the message itself. */
  thread?: { channel: string; ts: string };
  /** The sender's spoochie version. Missing means older than 0.8. */
  app?: string;
  /** In a "hola": my Nostr key and relays, so spoochies with me go encrypted. */
  np?: string;
  r?: string[];
};

/** A signed "hola" envelope. It is signed with the ed25519 key the other side has
 *  pinned from my earlier envelopes: unsigned, anyone with the bot token could put a
 *  Nostr key in my name. It is bound to the receiver and the time, like any other
 *  envelope since 0.9.9. */
export function signedHello(me: string, to: string, name: string, np: string, r: string[]): Envelope & { np: string; r: string[] } {
  const env: Envelope & { np: string; r: string[] } = {
    v: PROTOCOL, id: "hola", kind: "hola", from: me, to, fromName: name, np, r,
    app: VERSION, ts: Math.floor(Date.now() / 1000), sv: 2,
  };
  const k = myKeys(Cfg.load());
  env.pk = k.pub;
  env.sig = makeSignature(k.priv, env, np);
  return env;
}

/**
 * A key rotation envelope, signed with the OLD key.
 *
 * It is the only way to change a pinned key without every person re-inviting you by
 * hand: the receiver already has your old key pinned, checks with it that this message
 * is yours, and only then keeps the new one. If your old key was stolen, the thief can
 * sign this too: that is why the rotation is also stated as text in the DM, so the
 * person sees it and asks if they were not expecting it.
 */
export function signedRotation(me: string, to: string, name: string, newPub: string, priv: string, oldPub: string): Envelope & { pkNueva: string } {
  const env: Envelope & { pkNueva: string } = {
    v: PROTOCOL, id: "rota", kind: "rota", from: me, to, fromName: name, pkNueva: newPub,
    app: VERSION, ts: Math.floor(Date.now() / 1000), sv: 2,
  };
  env.pk = oldPub;
  env.sig = makeSignature(priv, env, newPub);
  return env;
}

/** Slack cuts each block at 3000 characters. Split on lines instead of slicing, which
 *  is what left a message ending in "p" mid-word. */
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
  return out.length > max ? [...out.slice(0, max - 1), "_(continued in the transcript)_"] : out;
}

/** A spoochie id is short, letters and digits: it ends up as a file name. */
export const VALID_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function envelopeOf(msg: any): Envelope | null {
  const p = msg?.metadata?.event_payload;
  // The id comes from outside and ends up in join(THREADS_DIR, id + ".json"): a
  // "../settings" would write outside the threads directory. No valid id, no envelope.
  return msg?.metadata?.event_type === EVENT && typeof p?.id === "string" && VALID_ID.test(p.id) && p?.from ? (p as Envelope) : null;
}

/** A system notice, on one line, in plain words. */
export function noticeText(t: T.Thread, rendered: string): string {
  const who = (s: T.Side) => s.human ?? s.name;
  if (isAcceptedNotice(rendered)) {
    const name = t.acceptedBy ?? who(t.to);
    return `:white_check_mark: ${name} accepted. The tunnel is open and dies on its own after 10 min of silence.`;
  }
  if (isClosedNotice(rendered)) {
    return `:lock: Spoochie closed${t.closeReason ? `: ${t.closeReason}` : ""}.`;
  }
  // Anything else: drop the internal instruction lines.
  return stripInternal(rendered);
}

type Block = Record<string, unknown>;

/**
 * What renderAccepted and renderClose look like: "accepted the tunnel", "closed (". The
 * Spanish markers of 0.9.10 and earlier ("ha aceptado el tunel", "cerrado (") still count.
 */
const isAcceptedNotice = (s: string) => s.includes("ha aceptado el tunel") || s.includes("accepted the tunnel");
const isClosedNotice = (s: string) => s.includes("cerrado (") || s.includes("closed (");
/** Drops the lines that are instructions for the local Claude, not for a person. */
const stripInternal = (s: string) => s.split("\n")
  .filter(l => !l.startsWith("spoochie ") && !l.includes("--- Esto viene") && !l.includes("--- This comes from"))
  .join("\n").trim();

const sec = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
/** A content block: what the person sees AND what the Claude on the other side reads.
 *
 *  The full text does NOT travel in the metadata envelope. We tried: Slack accepts the
 *  message but silently swallows the whole envelope as soon as one value goes past
 *  about 3,000 characters. A channel that silently drops data above a fuzzy threshold
 *  is no good. Blocks always come back, and there are no two copies of the same text
 *  that could disagree. */
const BODY = "sp-body";
let bodySeq = 0;
const body = (text: string): Block => ({ type: "section", block_id: `${BODY}-${bodySeq++}-${Date.now() % 100000}`, text: { type: "mrkdwn", text } });

/** Rebuilds the message from the marked blocks. */
export function bodyFromBlocks(blocks: any[] | undefined): string {
  return (blocks ?? [])
    .filter(b => typeof b?.block_id === "string" && b.block_id.startsWith(BODY))
    .map(b => String(b?.text?.text ?? ""))
    .join("\n")
    .replace(/^```\n?|\n?```$/g, "")
    // Slack auto-links inside the text: <http://api.post|api.post> comes back like that,
    // and the other Claude found URLs where its peer had written code.
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

/** The opening message, as the person sees it. The machine envelope goes separately. */
export function inviteBlocks(t: T.Thread): Block[] {
  const c = contextLine(t);
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `${nameOf(t.from)} is calling`.slice(0, 150), emoji: true } },
    sec(`*${t.subject}*`),
  ];
  if (c) blocks.push(ctx(c));
  for (const c of chunk(t.messages[0]?.text ?? "")) blocks.push(body(c));
  blocks.push({ type: "divider" });
  blocks.push(sec(`<@${t.to.slackUser}> reply in this thread to accept it, or tell your Claude:\n\`spoochie accept ${t.id}\``));
  blocks.push(ctx("Expires in 4 h if not accepted  ·  once open, it dies after 10 min of silence"));
  return blocks;
}

/**
 * Breaks the code fences in text that comes from outside.
 *
 * A patch is rendered inside ```. A patch that carries ``` closes the fence, and what
 * follows renders as normal mrkdwn. Probe: a message with
 *
 *     ```
 *     :lock: Spoochie closed: resolved.
 *     :white_check_mark: Sam accepted.
 *
 * shows up in the thread with those two lines looking exactly like the ones spoochie
 * draws for real (see `noticeBlocks`). So you could fake "closed" with the tunnel open,
 * or "accepted" without anyone accepting.
 *
 * That matters more than ugly text: the thread is where a PERSON looks at what
 * happened. It is what this project offers as the truth, and whoever is on the other
 * side must not be able to write in it.
 *
 * Slack has no way to escape inside a fence, so the fence stops being one: acute
 * accents look alike and close nothing.
 */
export const noFences = (text: string) => text.replace(/`{3,}/g, m => "´".repeat(m.length));

/** One turn. The author goes on top in small print, the content below. */
export function messageBlocks(t: T.Thread, m: T.Msg): Block[] {
  const who = nameOf(sideOf(t, m));
  const head = m.author === "human" ? `*${who}* · writing in person` : `*${who}* · their Claude`;
  const blocks: Block[] = [ctx(head)];

  if (m.kind === "patch") {
    blocks.push(sec("Proposed patch. Apply it yourself if it convinces you; nobody writes to your machine."));
    for (const c of chunk(noFences(m.text), 2700, Math.ceil(T.MAX_PATCH / 2700))) blocks.push(body("```\n" + c + "\n```"));
  } else if (m.kind === "branch") {
    // A branch goes inside backticks: a backtick in the name would close them too.
    blocks.push(body(`Branch to review: \`${m.text.replace(/`/g, "´")}\``));
  } else {
    for (const c of chunk(m.text)) blocks.push(body(c));
  }

  if (m.files?.length) blocks.push(ctx(m.files.map(f => `\`${f}\``).join("  ")));
  if (m.offTopic && m.offTopic.verdict !== "dentro") {
    blocks.push(ctx(`:warning: the watcher marks this *${T.verdictLabel(m.offTopic.verdict)}*: ${m.offTopic.why}`));
  }
  return blocks;
}

/** A system notice: one small line, never the internal text meant for Claude. */
export function noticeBlocks(t: T.Thread, rendered: string): { blocks: Block[]; text: string } {
  let text: string;
  if (isAcceptedNotice(rendered)) {
    text = `:white_check_mark: *${t.acceptedBy ?? nameOf(t.to)}* accepted. The tunnel is open.`;
  } else if (isClosedNotice(rendered)) {
    text = `:lock: Closed${t.closeReason ? ` · ${t.closeReason}` : ""}`;
  } else {
    text = stripInternal(rendered);
  }
  return { blocks: [ctx(text)], text };
}

/** A bare ack: accept, sure, ok. Not a conversation turn. The Spanish words stay:
 *  people on 0.9.10 and people who write in Spanish still type them. */
const ACKS = /^(acepto|aceptado|vale|ok|okey|oki|dale|si|sí|venga|adelante|perfecto|genial|gracias|okay|sure|yes|yep|yeah|accept|accepted|go ahead|got it|thanks|thank you|great|perfect|cool|👍|✅)[\s.!]*$/i;
export const isAck = (t: string) => ACKS.test(t.trim());
/** Below this length, what the receiver writes while pending is just "accept". */
export const BARE_ACCEPT = 60;

/** Plain fallback text: it is what shows in the phone notification. */
export function fallbackText(t: T.Thread, m: T.Msg): string {
  const who = nameOf(sideOf(t, m));
  if (m.kind === "patch") return `${who} sent you a patch`;
  if (m.kind === "branch") return `${who}: branch ${m.text}`;
  return `${who}: ${m.text.slice(0, 180)}`;
}

/** auth.test says who you are with that token, so setup does not ask for your user id. */
export async function whoIs(token: string): Promise<{ userId: string; user: string; team: string } | null> {
  try {
    const res = await fetch(API + "auth.test", { headers: { authorization: `Bearer ${token}` } });
    const j = await res.json();
    return j.ok ? { userId: j.user_id, user: j.user, team: j.team } : null;
  } catch { return null; }
}

type OnMessage = (t: T.Thread, m: T.Msg) => Promise<void>;
type OnAccept = (t: T.Thread, how: string) => Promise<void>;
type OnRemoteAccept = (t: T.Thread, how: string) => Promise<void>;
type OnOrder = (t: T.Thread, order: "suelta" | "descarta") => Promise<void>;
type OnClose = (t: T.Thread, reason: string) => Promise<void>;

/**
 * How often a daemon checks its inbox, given how many daemons share the app.
 *
 * `conversations.history` is Tier 3: about 50 calls per minute for the whole app. Half,
 * 25, is split among the daemons to discover new spoochies; the other half is left for
 * whoever just opened one and to stay off the limit. With 2 people that is 12 a minute
 * each, which hits the 5 s floor; with 4, 10 s; with 15, 36 s; with 25, 60 s. The team
 * is the contacts plus one. If Slack returns 429 anyway, the daemon freezes for as long
 * as Slack says (see `frozen`).
 */
export function discoveryCadence(team: number, floorMs = 5_000): number {
  return Math.max(floorMs, Math.round(Math.max(1, team) * 60_000 / 25));
}

export class SlackBridge {

  private lastDiscovery = 0;

  private botUserId: string | null = null;
  private seenHellos = new Set<string>();
  /** The other side closed the spoochie. */
  onCierre: OnClose | null = null;
  private myDm: string | null = null;
  /** On startup it looks back as far as the pending queue lasts: a spoochie older than
   *  that has already expired, and one from a minute ago has to show up even if the
   *  daemon started after it. */
  private inboxCursor = String(Math.round((Date.now() - T.PENDING_TTL_MS) / 1000));
  /** When Slack says enough, everything stops until this time. */
  private backoffUntil = 0;
  /** The "is looking" notice currently up in each thread, so it can be removed. */
  private thinking = new Map<string, { ts: string; since: number }>();
  /** If the other side does not reply, the "is looking" notice removes itself.
   *  An indicator that never goes away lies just like silence does. */
  private static THINKING_MAX_MS = 4 * 60 * 1000;

  private constructor(
    /** Empty if the app has bot users:read. It is only for looking people up: the bot
     *  always carries the traffic. Without it, one less thing to ask anyone for. */
    private userToken: string,
    private botToken: string,
    private me: string,
    private onMessage: OnMessage,
    private onAccept: OnAccept,
    private onRemoteAccept: OnRemoteAccept,
    private onOrder?: OnOrder,
  ) {}

  static fromConfig(onMessage: OnMessage, onAccept: OnAccept, onRemoteAccept: OnRemoteAccept, onOrder?: OnOrder, onClose?: OnClose): SlackBridge | null {
    const c = Cfg.load();
    const user = Cfg.slackToken(c);
    const bot = Cfg.slackBotToken(c);
    // The user token is no longer needed: if the app has bot users:read, the bot looks
    // people up just as well. What you cannot ask anyone for is a token you only get by
    // installing the app yourself.
    if (!bot || !c.slack?.userId) return null;
    const b = new SlackBridge(user ?? "", bot, c.slack.userId, onMessage, onAccept, onRemoteAccept, onOrder);
    b.onCierre = onClose ?? null;
    return b;
  }

  /** A 429 is not retried right away: Retry-After is respected and everything stops.
   *  Pushing against a rate limit is how it gets extended. */
  private noteLimit(res: Response) {
    const wait = Number(res.headers.get("retry-after") ?? 30);
    this.backoffUntil = Date.now() + (Number.isFinite(wait) ? wait : 30) * 1000;
  }

  private get frozen() { return Date.now() < this.backoffUntil; }

  private async call(method: string, body: Record<string, unknown>, as: "bot" | "user" = "bot"): Promise<any> {
    if (this.frozen) throw new Error("slack paused by rate limit");
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
    if (this.frozen) throw new Error("slack paused by rate limit");
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
  /** The workspace id, for the slack:// links in the notice dialog. */
  async teamId(): Promise<string | null> {
    if (this.team) return this.team;
    try { this.team = (await this.get("auth.test", {})).team_id ?? null; } catch { this.team = null; }
    return this.team;
  }

  /** Which version the other side runs. If it is an older line than mine, it is said
   *  ONCE in the thread: until then the only hint was that something did not work. Only
   *  the newer side says it, so it is not said twice. */
  private async noteVersion(t: T.Thread, env: Envelope) {
    const theirs = env.app ?? "0.7.1";
    const fresh = T.load(t.id) ?? t;
    if (fresh.versionOtro !== theirs) { fresh.versionOtro = theirs; T.save(fresh); }
    if (fresh.avisoVersion || versionLine(theirs) === versionLine(VERSION) || !newerThan(VERSION, theirs) || !fresh.slack) return;
    fresh.avisoVersion = true;
    T.save(fresh);
    const who = env.from === fresh.from.slackUser ? (fresh.from.human ?? fresh.from.name) : (fresh.to.human ?? fresh.to.name);
    await this.aviso(fresh, `:information_source: ${who} has spoochie ${theirs} and this side has ${VERSION}. Some things may not work the same for them: \`/plugin update ${PLUGIN}\` and restart a session.`);
  }

  /** The DM between the bot and me: the only channel to watch for what comes in. */
  private async inbox(): Promise<string | null> {
    if (this.myDm) return this.myDm;
    try {
      if (!this.botUserId) this.botUserId = (await this.get("auth.test", {})).user_id;
      const im = await this.call("conversations.open", { users: this.me });
      this.myDm = im.channel.id;
      return this.myDm;
    } catch { return null; }
  }

  /** Who asks about people. The bot if the app has users:read; otherwise the user token
   *  of whoever has one. Looking people up is the only thing that needs this. */
  private lookupAs(): "bot" | "user" { return this.userToken ? "user" : "bot"; }

  async lookupUser(needle: string): Promise<SlackUser | null> {
    // A Slack id is taken as is: it is the only thing that cannot be ambiguous.
    if (/^[UWB][A-Z0-9]{6,}$/.test(needle)) {
      try {
        const r = await this.get("users.info", { user: needle }, this.lookupAs());
        return { id: needle, name: r.user?.profile?.real_name ?? r.user?.name ?? needle };
      } catch { return { id: needle, name: needle }; }
    }
    if (needle.includes("@")) {
      try {
        const r = await this.get("users.lookupByEmail", { email: needle }, this.lookupAs());
        return { id: r.user.id, name: r.user.profile?.real_name ?? r.user.name };
      } catch { return null; }
    }
    const r = await this.get("users.list", { limit: "500" }, this.lookupAs());
    const n = needle.toLowerCase();
    const hit = (r.members ?? []).find((u: any) =>
      !u.deleted && !u.is_bot &&
      [u.name, u.profile?.display_name, u.profile?.real_name].filter(Boolean)
        .some((x: string) => x.toLowerCase() === n || x.toLowerCase().replace(/\s+/g, "") === n));
    return hit ? { id: hit.id, name: hit.profile?.real_name ?? hit.name } : null;
  }

  /** Where the thread of a spoochie I open will live.
   *
   *  With the thread in the DM between the bot and the receiver, the opener could not
   *  see it in Slack: Edu opened one to Sam and only Sam had the conversation in front
   *  of them. Now, by default, the thread goes to a group DM of bot + me + the other
   *  person, which we both see. The receiver's DM with the bot still gets a notice with
   *  the full invite, because it is the only channel their daemon watches; that notice's
   *  envelope says where the real thread is. If the app lacks mpim:write, the group
   *  cannot be opened and the thread stays in the DM, as before. */
  private async threadHome(t: T.Thread, dm: string): Promise<{ channel: string; kind: "group" | "channel" | "dm" }> {
    const c = Cfg.load().slack;
    // "grupo" and "canal" are config values on disk.
    const mode = c?.hilos ?? "grupo";
    if (mode === "canal" && c?.canal) return { channel: c.canal, kind: "channel" };
    if (mode === "grupo") {
      try {
        const g = await this.call("conversations.open", { users: `${this.me},${t.to.slackUser}` });
        if (g?.channel?.id) return { channel: g.channel.id, kind: "group" };
      } catch (e) {
        if (!this.warnedNoGroup) { this.warnedNoGroup = true; console.error(`spoochie: cannot open the bot+you+${t.to.human ?? t.to.name} group (${String(e).replace(/^Error: /, "")}); the thread goes to the receiver's DM. Add mpim:write, mpim:read and mpim:history to the Slack app.`); }
      }
    }
    return { channel: dm, kind: "dm" };
  }
  private warnedNoGroup = false;

  async openThread(t: T.Thread): Promise<{ channel: string; ts: string } | null> {
    // The DM between the bot and the receiver: the channel their daemon watches.
    const im = await this.call("conversations.open", { users: t.to.slackUser });
    const dm: string = im.channel.id;
    const { channel, kind } = await this.threadHome(t, dm);
    let dmNotice: { channel: string; ts: string } | undefined;
    const env: Envelope = {
      v: PROTOCOL, id: t.id, kind: "invite", from: t.from.slackUser ?? this.me,
      subject: t.subject, fromName: t.from.human ?? t.from.name, context: t.context,
    };
    this.sign(env, t.messages[0]?.text ?? "", t.to.slackUser);
    const post = await this.call("chat.postMessage", {
      channel,
      text: `${t.from.human ?? t.from.name} is calling: ${t.subject}`,
      blocks: inviteBlocks(t),
      metadata: { event_type: EVENT, event_payload: env },
      unfurl_links: false,
    });
    if (kind !== "dm") {
      // The notice in the receiver's DM: the same invite, with the envelope pointing to
      // the real thread, and a link for the person.
      let link = kind === "group" ? "your group with the bot" : "the spoochie channel";
      try { const p = await this.call("chat.getPermalink", { channel, message_ts: post.ts }); if (p?.permalink) link = `<${p.permalink}|${link}>`; } catch {}
      const dmPost = await this.call("chat.postMessage", {
        channel: dm,
        text: `${t.from.human ?? t.from.name} is calling: ${t.subject}`,
        blocks: [...inviteBlocks(t), ctx(`The conversation continues in ${link}, where you both see it.`)],
        metadata: { event_type: EVENT, event_payload: { ...env, thread: { channel, ts: post.ts } } },
        unfurl_links: false,
      });
      dmNotice = { channel: dm, ts: dmPost.ts };
    }
    // The first message's files go up to the new thread. Only post() used to upload
    // them, so a screenshot attached on open stayed on the machine.
    for (const f of t.messages[0]?.files ?? []) {
      await upload(this.botToken, f, channel, post.ts);
    }
    return { channel, ts: post.ts, ...(dmNotice ? { aviso: dmNotice } : {}) };
  }

  /** Sends a person my Nostr key over their DM with the bot. That way someone already on
   *  spoochie over Slack moves to Nostr without joining again: their daemon stores it in
   *  their contacts and replies with theirs. */
  async hola(userId: string, np: string, r: string[], name: string): Promise<boolean> {
    try {
      const im = await this.call("conversations.open", { users: userId });
      await this.call("chat.postMessage", {
        channel: im.channel.id, text: `${name} can now talk to you over Nostr (encrypted, not through Slack).`,
        blocks: [ctx(`:key: ${name} can now talk to you over Nostr: spoochies between you will be encrypted and will not go through Slack. Slack will keep notifying you.`)],
        // Signed with my ed25519 key (the one they already pinned from my envelopes):
        // unsigned, anyone with the bot token could put a key in my name.
        metadata: { event_type: EVENT, event_payload: signedHello(this.me, userId, name, np, r) },
      });
      return true;
    } catch { return false; }
  }
  /** Tells a person I changed my signing key, signed with the old one. */
  async rotar(userId: string, newPub: string, priv: string, oldPub: string, name: string): Promise<boolean> {
    try {
      const im = await this.call("conversations.open", { users: userId });
      await this.call("chat.postMessage", {
        channel: im.channel.id, text: `${name} changed their spoochie signing key.`,
        blocks: [ctx(`:key: ${name} changed their spoochie signing key. Your Claude checks it against the key it already had pinned and keeps the new one. *If ${name} did not tell you they were rotating, ask them through some other channel before going on.*`)],
        metadata: { event_type: EVENT, event_payload: signedRotation(this.me, userId, name, newPub, priv, oldPub) },
      });
      return true;
    } catch { return false; }
  }
  /** On receiving a rotation over Slack. */
  onRota: ((from: string, newPk: string, verdict: Verdict) => Promise<void>) | null = null;

  /** On receiving a hola over Slack. */
  onHola: ((from: string, name: string, np: string, r: string[], verdict: Verdict) => Promise<void>) | null = null;

  /** A notice to a person over their DM with the bot, with no envelope: the thread lives elsewhere. */
  async avisarDm(userId: string, text: string): Promise<boolean> {
    try {
      const im = await this.call("conversations.open", { users: userId });
      await this.call("chat.postMessage", { channel: im.channel.id, text, blocks: [ctx(text)], metadata: { event_type: EVENT, event_payload: { v: PROTOCOL, id: "aviso", kind: "notice", from: this.me } } });
      return true;
    } catch { return false; }
  }

  /**
   * Deletes from Slack everything the bot posted for this spoochie: the whole thread
   * (root and bot replies), the files it uploaded, and the notice in the receiver's DM.
   * The bot cannot delete what a person wrote by hand; that stays, without context.
   * Returns how many messages were deleted. Both daemons try it: it is idempotent.
   */
  async borrarHilo(t: T.Thread): Promise<number> {
    if (!t.slack) return 0;
    let n = 0;
    const del = async (channel: string, ts: string) => { try { await this.call("chat.delete", { channel, ts }); n++; } catch {} };
    let replies: any[] = [];
    try { replies = (await this.get("conversations.replies", { channel: t.slack.channel, ts: t.slack.ts, limit: "200" })).messages ?? []; } catch {}
    for (const r of replies) {
      if (r.ts === t.slack.ts) continue;
      if (!r.bot_id && !(this.botUserId && r.user === this.botUserId)) continue;
      for (const f of r.files ?? []) { try { await this.call("files.delete", { file: f.id }); } catch {} }
      await del(t.slack.channel, r.ts);
    }
    const root = replies.find(r => r.ts === t.slack!.ts);
    if (!root || root.bot_id || (this.botUserId && root.user === this.botUserId)) await del(t.slack.channel, t.slack.ts);
    if (t.slack.aviso) await del(t.slack.aviso.channel, t.slack.aviso.ts);
    return n;
  }

  async post(t: T.Thread, notice: string, m?: T.Msg): Promise<boolean> {
    if (!t.slack) return false;
    await this.pensandoOff(t);
    const mine = t.from.slackUser === this.me ? t.from : t.to;
    const env: Envelope = {
      v: PROTOCOL, id: t.id,
      kind: m ? "msg" : isAcceptedNotice(notice) ? "accept" : isClosedNotice(notice) ? "close" : "notice",
      from: mine.slackUser ?? this.me,
      ...(m ? { kindOfMsg: m.kind } : {}),
    };
    const body: any = m
      ? { text: fallbackText(t, m), blocks: messageBlocks(t, m) }
      : noticeBlocks(t, notice);
    // What gets signed is what the other side will rebuild, which is the block body. Up to
    // 0.9.10 a message signed m.text instead, and a branch, whose body carries a label,
    // arrived with a signature that did not match and was dropped.
    // `accept` and `close` used to go unsigned, and they are the two envelopes that DO
    // something on arrival: open the tunnel, and close it purging the thread. `notice`
    // stays unsigned because it does nothing on arrival, and signing it would mean also
    // signing the ones the receiver posts ("is looking at their code"), which have no
    // owner in the thread.
    if (m || env.kind === "accept" || env.kind === "close") {
      this.sign(env, bodyFromBlocks(body.blocks) || (m ? m.text : body.text || ""), T.otherSide(t, mine.sessionId).slackUser);
    }
    // Files go to the thread before the text, so they are read together.
    if (m?.files?.length) {
      for (const f of m.files) await upload(this.botToken, f, t.slack.channel, t.slack.ts);
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
   * A notice that the other side is working. Without it there are 30 or 40 seconds of
   * blank screen where nobody knows whether the tunnel died.
   * It goes up when a turn is delivered and comes down as soon as the reply arrives.
   */
  async pensandoOn(t: T.Thread, who: string) {
    if (!t.slack || this.thinking.has(t.id)) return;
    try {
      const r = await this.call("chat.postMessage", {
        channel: t.slack.channel, thread_ts: t.slack.ts,
        text: `${who} is looking at their code…`,
        blocks: [ctx(`:hourglass_flowing_sand: _${who} is looking at their code…_`)],
        // Without an envelope, the daemon on the other side took it as a person typing,
        // and its Claude got "Sam is looking at their code" as a turn.
        metadata: { event_type: EVENT, event_payload: { v: PROTOCOL, id: t.id, kind: "notice", from: this.me } },
      });
      this.thinking.set(t.id, { ts: r.ts, since: Date.now() });
    } catch {}
  }

  async pensandoOff(t: T.Thread) {
    const p = this.thinking.get(t.id);
    if (!p || !t.slack) return;
    this.thinking.delete(t.id);
    try { await this.call("chat.delete", { channel: t.slack.channel, ts: p.ts }); } catch {}
  }

  /** Sweeps indicators that have been up too long. */
  private async sweepThinking() {
    for (const [id, p] of [...this.thinking]) {
      if (Date.now() - p.since < SlackBridge.THINKING_MAX_MS) continue;
      const t = T.load(id);
      this.thinking.delete(id);
      if (t?.slack) { try { await this.call("chat.delete", { channel: t.slack.channel, ts: p.ts }); } catch {} }
    }
  }

  /**
   * Call budget.
   *
   * `conversations.replies` and `conversations.history` are Tier 3: around 50 per minute
   * per method, counted **per app**, not per person. Since the whole team shares one
   * app, everyone's usage lands in the same bucket. My first attempt (6 threads every
   * 4s) came to 105 calls per minute per daemon: for fourteen people, not even close.
   *
   * Discovery (history) is split by discoveryCadence: 25 calls per minute across all
   * daemons, whether 2 or 25, with a 5 s floor per daemon. Live threads (replies) run at
   * 12/min per daemon with a conversation, at most 4 threads per tick. For 15 people with
   * two live conversations: 25 history and 24 replies per minute, against a limit of 50
   * each.
   */
  private static MAX_THREADS = 4;
  private static RECENT_MS = 2 * 60 * 1000;
  private wheel = 0;
  private lastLook = new Map<string, number>();
  private lastDiscoverAt = 0;

  /** What this daemon spends right now, so `spoochie doctor` can report it. */
  presupuesto(): { hilos: number; historyPorMin: number; repliesPorMin: number } {
    const live = T.all().filter(t => t.state !== "closed" && t.slack).length;
    const cadence = discoveryCadence(Object.keys(Cfg.load().contacts ?? {}).length + 1);
    return {
      hilos: live,
      historyPorMin: Math.round(60_000 / cadence),
      repliesPorMin: Math.min(live, SlackBridge.MAX_THREADS) * 12,
    };
  }

  async poll(): Promise<void> {
    if (this.frozen) return;
    const now = Date.now();
    const open = T.all().filter(t => t.state !== "closed" && t.slack);

    // Only chase threads that moved recently. An open but idle one takes its turn, so
    // none goes unchecked and none hogs the budget.
    const recent = open.filter(t => now - t.lastActivityAt < SlackBridge.RECENT_MS);
    const idle = open.filter(t => now - t.lastActivityAt >= SlackBridge.RECENT_MS);
    const queue = [...recent];
    for (let i = 0; i < idle.length && queue.length < SlackBridge.MAX_THREADS; i++) {
      queue.push(idle[(this.wheel + i) % idle.length]);
    }
    this.wheel = (this.wheel + 1) % Math.max(idle.length, 1);

    for (const t of queue.slice(0, SlackBridge.MAX_THREADS)) {
      this.lastLook.set(t.id, now);
      await this.pollThread(t);
      if (this.frozen) return;
    }

    // The inbox is checked as often as the shared quota allows for the team's size.
    const cadence = discoveryCadence(Object.keys(Cfg.load().contacts ?? {}).length + 1);
    if (now - this.lastDiscoverAt >= cadence) {
      this.lastDiscoverAt = now;
      await this.discover();
    }
    await this.sweepThinking();
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
      // The cursor is saved before delivering: if something blows up halfway, one
      // message is lost, which beats reinjecting the whole thread in a loop.
      const current = T.load(t.id);
      if (current) { current.slackCursor = rep.ts; T.save(current); t.slackCursor = rep.ts; }

      // Files shared in the thread: downloaded to the spool and announced with their
      // local path, which is the only thing this machine's Claude can open.
      const theirFiles = (rep as any).files as any[] | undefined;
      if (theirFiles?.length && rep.user !== this.me) {
        const paths = await download(this.botToken, theirFiles, t.id);
        if (paths.length) {
          await this.onMessage(t, {
            at: Math.round(Number(rep.ts) * 1000),
            from: T.otherSide(t, this.localSideId(t)).sessionId,
            author: "claude", kind: "text",
            text: `I left you ${paths.length === 1 ? "a file" : `${paths.length} files`} in the thread. They are already downloaded on this machine; open them if you want.`,
            files: paths,
          });
        }
      }
      if (rep.subtype === "file_share" && !(rep.text ?? "").trim()) continue;
      if (rep.subtype && rep.subtype !== "file_share") continue;

      const env = envelopeOf(rep);
      if (env) await this.noteVersion(t, env);
      if (env) {
        // spoochie posted it. Both sides post as the bot, so who is speaking is only
        // known from the envelope. Without this a daemon skips the other one.
        if (env.from === this.me) continue;
        // A `notice` does nothing on arrival, and the `invite` is verified in `discover`.
        // Everything else goes through the signature before touching anything.
        if (env.kind === "notice" || env.kind === "invite") continue;
        const text = bodyFromBlocks((rep as any).blocks) || rep.text || "";
        // Before the signature: if I cannot read the envelope, I cannot claim anything about it.
        const reading = readVersion(env.v, env.app);
        if (!reading.entiendo) {
          await this.aviso(t, `:warning: a message from ${env.fromName ?? env.from}: ${reading.por}`);
          continue;
        }
        const verdict = verifyEnvelope(env, text);
        if (verdict === "ok" || verdict === "nueva" || verdict === "vieja") Cfg.touchContact({ id: env.from });
        // What is not delivered, and why. Only "mala" used to be stopped; a good
        // signature on an old replayed envelope, or one meant for someone else, got in.
        const REJECTED: Record<string, string> = {
          mala: `carried a signature that is not theirs`,
          caducada: `was signed more than a day ago: someone saved it and released it again`,
          ajena: `was signed for someone else, not for you`,
          degradada: `came unsigned, and I already have a pinned key for ${env.from}: an old version of theirs cannot drop the signature`,
          desconocida: `came from an id that is not in your contacts: you did not invite them and they did not invite you`,
        };
        if (REJECTED[verdict]) {
          // Not delivered. It is said in the thread, which is where people see it.
          const what = env.kind === "accept" ? "an accept" : env.kind === "close" ? "a close" : "a message";
          await this.aviso(t, `:no_entry: ${what} claiming to come from ${env.fromName ?? env.from} ${REJECTED[verdict]}. Dropped.`);
          continue;
        }
        // With the signature checked: the two envelopes that act on their own.
        //
        // For these two "not rejected" is not enough: they need a real signature. An
        // unsigned envelope from an id with no pinned key is delivered as a message,
        // marked unsigned, because whoever reads it is a person who sees the mark. Nobody
        // reads an `accept` or a `close`: they open the tunnel, or close it and purge the
        // thread, by themselves. Unsigned means nothing happens, and the thread says so.
        if (env.kind === "accept" || env.kind === "close") {
          // "vieja" (v1 signature) does not count for these two, and that breaks nothing:
          // checked in the 0.9.8 tree, `post` only signed the invite and messages, never
          // an accept or a close. So accepting v1 here buys compatibility with nobody and
          // opens a door: v1 signs neither time nor recipient, so one of its envelopes is
          // valid forever and in any thread.
          if (verdict !== "ok" && verdict !== "nueva") {
            await this.aviso(t, `:no_entry: ${env.kind === "accept" ? "an accept" : "a close"} from ${env.fromName ?? env.from} came unsigned. Dropped: anyone with the bot token can post this.`);
            continue;
          }
        }
        if (env.kind === "accept") { await this.onRemoteAccept(t, "on the other machine"); continue; }
        // The other side's close: it used to be just another notice and got ignored, and
        // this side found out from silence 10 min later. Now it closes (and erases) here too.
        // The reason is read from "cerrado (...)" as 0.9.10 writes it, or "closed (...)".
        if (env.kind === "close") { if (this.onCierre) await this.onCierre(t, /(?:cerrado|closed) \(([^)]*)\)/.exec(rep.text ?? "")?.[1] ?? "closed by the other side"); continue; }
        await this.onMessage(t, {
          at: Math.round(Number(rep.ts) * 1000),
          from: T.otherSide(t, this.localSideId(t)).sessionId,
          author: "claude",
          kind: env.kindOfMsg ?? "text",
          text,
          firma: verdict,
        });
        continue;
      }

      // No envelope: a person wrote this by hand in Slack.
      const text = (rep.text ?? "").trim();
      const mine = rep.user === this.me;
      // In a group both people write. While the tunnel is pending, only the receiver can
      // open it by writing: whatever the other person says before that does not count.
      if (t.state === "pending" && rep.user !== t.to.slackUser) continue;

      // I am the receiver and I write in the thread while it is pending: that IS accepting.
      // My own daemon used to skip my messages and the tunnel never opened from Slack,
      // while the daemon on the other side did forward my "acepto".
      // And what I write there is not a conversation turn unless it is long: in e856 an
      // "aceptarlo" was forwarded to the other person as if it were a message.
      if (mine && t.to.slackUser === this.me && t.state === "pending") {
        await this.onAccept(t, "in Slack");
        if (isAck(text) || text.length < BARE_ACCEPT) continue;
      }
      // The receiver's "release" / "discard" for what the watcher held. The Spanish
      // words stay for people who type them.
      if (mine && this.onOrder && /^(suelta|libera|entrega|release|deliver)[\s.!]*$/i.test(text)) { await this.onOrder(t, "suelta"); continue; }
      if (mine && this.onOrder && /^(descarta|tira|discard|drop)[\s.!]*$/i.test(text)) { await this.onOrder(t, "descarta"); continue; }
      // My own messages do not come back to my own session.
      if (mine) continue;
      // A bare "ok" is not a turn: forwarding it only gets the Claude on the other end
      // to reply "an ok is not enough for me".
      if (isAck(text)) continue;
      // An empty message is not delivered. It happened with attachments without text:
      // the other side got "Someone (human, in person):" and nothing below it.
      if (!text) continue;
      await this.onMessage(t, {
        at: Math.round(Number(rep.ts) * 1000),
        from: T.otherSide(t, this.localSideId(t)).sessionId,
        author: "human", kind: "text", text,
      });
    }
  }

  /** A spoochie notice in the thread, with an envelope so no daemon takes it for a person. */
  async aviso(t: T.Thread, text: string) {
    if (!t.slack) return;
    await this.noticeIn(t.slack.channel, t.slack.ts, text);
  }
  private async noticeIn(channel: string, thread_ts: string, text: string) {
    try {
      await this.call("chat.postMessage", {
        channel, thread_ts, text, blocks: [ctx(text)],
        metadata: { event_type: EVENT, event_payload: { v: PROTOCOL, id: "aviso", kind: "notice", from: this.me } },
      });
    } catch {}
  }

  /** Signs the envelope with my keys. With no keys (config from before signed join),
   *  the envelope goes out unsigned and the other side sees it marked. */
  private sign(env: Envelope, text: string, to?: string) {
    env.app = VERSION;
    const c = Cfg.load();
    if (!c.slack) return;
    const k = myKeys(c);
    // Everything the signature has to bind is set BEFORE signing, and travels in the
    // envelope so the other side rebuilds the same bytes.
    if (to) env.to = to;
    env.ts = Math.floor(Date.now() / 1000);
    env.sv = 2;
    env.pk = k.pub;
    env.sig = makeSignature(k.priv, env, text);
  }

  /** Which of the two sides I am in this thread. */
  private localSideId(t: T.Thread): string {
    return t.to.slackUser === this.me ? t.to.sessionId : t.from.sessionId;
  }

  /** Discovers spoochies opened to me. One call, to one channel. */
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
      if (env?.kind === "hola" && env.from !== this.me && env.np && /^[0-9a-f]{64}$/.test(env.np) && !this.seenHellos.has(msg.ts)) {
        this.seenHellos.add(msg.ts);
        if (this.onHola) await this.onHola(env.from, env.fromName ?? env.from, env.np, Array.isArray(env.r) ? env.r : [], verifyEnvelope({ id: "hola", kind: "hola", from: env.from, fromName: env.fromName, pk: env.pk, sig: env.sig }, env.np));
        continue;
      }
      if (env?.kind === "rota" && env.from !== this.me && typeof (env as any).pkNueva === "string") {
        // Checked against the key that was ALREADY pinned: the signed text is the new one.
        if (this.onRota) await this.onRota(env.from, (env as any).pkNueva, verifyEnvelope(env, (env as any).pkNueva));
        continue;
      }
      if (!env || env.kind !== "invite" || known.has(env.id) || env.from === this.me) continue;
      const inviteReading = readVersion(env.v, env.app);
      if (!inviteReading.entiendo) {
        known.add(env.id);
        await this.noticeIn(ch, msg.thread_ts ?? msg.ts, `:warning: an invite from ${env.fromName ?? env.from}: ${inviteReading.por}`);
        continue;
      }
      const inviteVerdict = verifyEnvelope(env, bodyFromBlocks(msg.blocks));
      if (inviteVerdict === "mala" || inviteVerdict === "caducada" || inviteVerdict === "ajena" || inviteVerdict === "degradada" || inviteVerdict === "desconocida") {
        known.add(env.id);
        const why = inviteVerdict === "mala" ? "but the signature is not theirs"
          : inviteVerdict === "caducada" ? "but it was signed more than a day ago"
          : inviteVerdict === "degradada" ? "but it came unsigned, and I already have a key for that person"
          : inviteVerdict === "desconocida" ? "but that id is not in your contacts"
          : "but it was signed for someone else";
        await this.noticeIn(ch, msg.thread_ts ?? msg.ts, `:no_entry: this invite claims to come from ${env.fromName ?? env.from} ${why}. Dropped.`);
        continue;
      }
      // A spoochie this machine already knew does not come back, even if state is wiped.
      if (T.alreadySeen(env.id)) continue;
      // And one person cannot fill your state with unanswered spoochies.
      if (!T.roomForAnotherFrom(`slack:${env.from}`)) {
        known.add(env.id);
        await this.noticeIn(ch, msg.thread_ts ?? msg.ts, `:hourglass: you already have ${T.MAX_PENDING_PER_PERSON} unanswered spoochies from ${env.fromName ?? env.from}. This one is not let in; reply to one or let one expire.`);
        continue;
      }
      // The DM notice can point to the real thread (a group or a channel).
      await this.materialize(env, env.thread?.channel ?? ch, env.thread?.ts ?? msg.thread_ts ?? msg.ts, bodyFromBlocks(msg.blocks));
    }
  }

  /** Creates the local thread for a spoochie that arrives from another machine. It stays
   *  pending until my human accepts: the daemon delivers the invite to the local session
   *  that fits, or to the next one that registers. */
  private async materialize(env: Envelope, channel: string, ts: string, firstText = "") {
    const now = Date.now();
    // The name comes from your contacts, not the envelope: `fromName` is not signed, so
    // an envelope signed by one person could show up under someone else's name, and that
    // name is the first thing read in the notice. See `displayName`.
    // "(otra maquina)", "(esta maquina)" and "yo" are stored values; daemon.ts and
    // nostr.ts write the same ones.
    const name = T.displayName(Cfg.contactById(Cfg.load(), env.from)?.name, env.fromName, env.from);
    const t: T.Thread = {
      id: env.id,
      subject: T.outsideSubject(env.subject),
      from: { sessionId: `slack:${env.from}`, name, cwd: "(otra maquina)", human: name, slackUser: env.from },
      to: { sessionId: `slack:${this.me}`, name: "yo", cwd: "(esta maquina)", slackUser: this.me },
      state: "pending",
      createdAt: now,
      lastActivityAt: now,
      context: T.outsideContext(env.context),
      slack: { channel, ts },
      messages: [],
    };
    T.save(t);
    await this.onMessage(t, {
      at: now, from: t.from.sessionId, author: "claude", kind: "text",
      text: firstText || "(the opening message arrived empty)",
    });
  }
}
