/**
 * One daemon per machine. It is the only thing that stays alive between turns, so it
 * keeps the clocks: a Claude only exists while it thinks.
 *
 * It routes between local sessions through each one's inbound socket, and between
 * machines through Slack (src/slack.ts), where the thread is at once transport,
 * address and source of truth for the state.
 */
import net from "node:net";
import { existsSync, unlinkSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DAEMON_SOCK, DAEMON_LOCK, DAEMON_LOG, ensureDirs } from "./paths.ts";
import { liveSessions, findSession, unregister, type SessionRecord } from "./registry.ts";
import * as T from "./threads.ts";
import { enqueue, resume } from "./outbox.ts";
import { newVersionNotice } from "./update.ts";
import { VERSION } from "./version.ts";
import { beat, HEARTBEAT_MS } from "./startup.ts";
import * as Ap from "./aside.ts";
import * as Dlg from "./dialog.ts";
import * as Strangers from "./strangers.ts";
import * as Cfg from "./config.ts";
import * as Conf from "./trust.ts";
import * as Aud from "./audit.ts";
import { deliver } from "./inbox.ts";
import { judge } from "./guardian.ts";
import { publishTranscript, transcriptPath } from "./transcript.ts";
import { SPOOL, sweepOrphans } from "./files.ts";
import { helloDue } from "./hellos.ts";
import { helloByNostr, helloBySlack } from "./keys.ts";
import { join } from "node:path";
import { SlackBridge } from "./slack.ts";
import { NostrBridge, filePool, pkOf, DEFAULT_RELAYS } from "./nostr.ts";
import { repoMatches } from "./match.ts";

/** With a fixed 20s tick, every hop through the tunnel ate up to 20s of waiting and a
 *  6-message conversation piled up two minutes of nothing. While a spoochie is open it
 *  checks every 4s; at rest, every 5s: the tick itself doesn't call Slack, it only
 *  decides whether it's time to discover, so it costs nothing. */
const TICK_IDLE_MS = 5_000;
const TICK_LIVE_MS = 4_000;

export function log(...a: unknown[]) {
  const line = `${new Date().toISOString()} ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`;
  try { appendFileSync(DAEMON_LOG, line); } catch {}
}

function alreadyRunning(): boolean {
  if (!existsSync(DAEMON_LOCK)) return false;
  const pid = Number(readFileSync(DAEMON_LOCK, "utf8").trim());
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type Req = { op: string; [k: string]: any };

let slack: SlackBridge | null = null;
let nostr: NostrBridge | null = null;
/** The bridge a thread with another machine travels over. */
const bridge = (t: T.Thread) => (t.transporte === "nostr" ? nostr : slack) as (SlackBridge | NostrBridge | null);
const hasThread = (t: T.Thread) => Boolean(t.transporte === "nostr" ? t.nostr : t.slack);

/** Appends the request to republish the transcript to the turn already headed for that session. */
function withTranscript(t: T.Thread, sessionId: string, text: string): string {
  if (!Cfg.load().transcript) return text;
  const task = T.transcriptTask(t, sessionId, transcriptPath(t.id));
  return task ? text + "\n" + task : text;
}

async function send(sess: SessionRecord | undefined, text: string) {
  if (!sess) return false;
  const ap = sess.aparte ? asides.get(sess.aparte) : undefined;
  if (ap) {
    // In the background the aside receives through its standard input, which belongs to the daemon.
    if (ap.mode === "background") return Ap.alive(ap) ? Ap.stdinTurn(ap, text) : false;
    // The window hasn't registered yet: it's kept for it. Nothing lands in another session.
    if (!ap.ready) { ap.queue.push(text); return true; }
  }
  try { await deliver(sess, text); return true; }
  catch (e) { log("deliver-failed", sess.sessionId, String(e)); return false; }
}

/** The live aside Claudes, by spoochie id. */
const asides = new Map<string, Ap.Aside>();
/** Launches in progress, so two accept/take at once don't open two windows. */
const launching = new Map<string, Promise<SessionRecord | null>>();

/** Launches (or reuses) a spoochie's aside Claude in that directory and assigns it. */
function attend(t: T.Thread, cwd: string): Promise<SessionRecord | null> {
  const inFlight = launching.get(t.id);
  if (inFlight) return inFlight;
  const p = attendNow(t, cwd).catch(e => { log("aside", t.id, "failed:", String(e)); return null; }).finally(() => launching.delete(t.id));
  launching.set(t.id, p);
  return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Starts a `claude -p` and checks it doesn't die on the spot. */
async function startBackground(t: T.Thread, cwd: string): Promise<Ap.Aside | null> {
  const ap = Ap.launch(t, cwd, "background");
  if (!ap) return null;
  asides.set(t.id, ap);
  ap.child!.on("error", e => log("aside", t.id, "won't start:", String(e)));
  ap.child!.on("exit", code => { if (asides.get(t.id) === ap) asides.delete(t.id); unregister(ap.sess.sessionId); log("aside", t.id, "exited", code); });
  await sleep(300);
  if (ap.child!.exitCode !== null) { log("aside", t.id, "won't start; see", `${Ap.ASIDE_DIR}/${t.id}.log`); asides.delete(t.id); unregister(ap.sess.sessionId); return null; }
  return ap;
}

/** Waits for the window's SessionStart hook to write its record with a socket. */
async function waitForWindow(ap: Ap.Aside, ms: number): Promise<SessionRecord | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rec = Ap.windowRecord(ap, liveSessions());
    if (rec) return rec;
    await sleep(500);
  }
  return undefined;
}

/** The old window learns that the spoochie has moved somewhere else. */
async function dismiss(ap: Ap.Aside, why: string) {
  if (ap.mode === "background") { Ap.killAside(ap); return; }
  const rec = Ap.windowRecord(ap, liveSessions());
  if (rec) { try { await deliver(rec, `[spoochie ${ap.id}] ${why}. This window no longer handles anything: you can close it.`); } catch {} }
  unregister(ap.sess.sessionId);
}

async function attendNow(t: T.Thread, cwd: string): Promise<SessionRecord | null> {
  const old = asides.get(t.id);
  // There's already a live one in that same repo: it isn't relaunched. That's what happened in e856,
  // where two accepts in a row killed the first one and the second was born in the wrong repo.
  if (old && Ap.alive(old) && (old.origin ?? old.cwd) === cwd && sessById(old.sess.sessionId)) { log("aside", t.id, "already alive in", cwd); return old.sess; }
  if (old) { asides.delete(t.id); await dismiss(old, `is now handled from ${cwd}`); }

  // On a clean copy of the repo, not on the person's checkout.
  const origin = cwd;
  const copy = Cfg.load().aparteCopia !== false ? Ap.worktreeCopy(origin, t.id) : null;
  if (Cfg.load().aparteCopia !== false && !copy) log("aside", t.id, "no copy (not a git repo or the worktree failed); on the checkout");
  cwd = copy ?? origin;
  let ap = Ap.asideMode() === "window" ? Ap.launch(t, cwd, "window") : null;
  if (ap) asides.set(t.id, ap);
  else {
    if (Ap.asideMode() === "window") log("aside", t.id, "couldn't open a window; going to the background");
    ap = await startBackground(t, cwd);
    if (!ap) return null;
  }
  ap.origin = origin;

  // The spoochie points to the aside from now on: whatever arrives while it starts is kept
  // for it, and doesn't land in the session where the person works.
  const fresh = T.load(t.id) ?? t;
  fresh.to = { ...fresh.to, sessionId: ap.sess.sessionId, name: ap.sess.name, cwd, human: Cfg.load().human ?? fresh.to.human };
  fresh.copiaDe = copy ? origin : undefined;
  // A spoochie coming from outside had nobody to publish its transcript: the daemon
  // can't, and the interactive session mustn't see it. The aside is a Claude session: it does it.
  if (Cfg.load().transcript && !fresh.transcriptOwner) fresh.transcriptOwner = ap.sess.sessionId;
  T.save(fresh);
  const first = withTranscript(fresh, ap.sess.sessionId, Ap.firstTurn(fresh, ap.sess.sessionId, Ap.cliCommand(), cwd, copy ? origin : undefined));

  if (ap.mode === "background") {
    Ap.stdinTurn(ap, first);
    log("aside", t.id, "handled in the background in", cwd);
    return ap.sess;
  }

  const rec = await waitForWindow(ap, 60_000);
  if (!rec) {
    log("aside", t.id, "the window didn't register in 60 s (old plugin in that session?); continuing in the background");
    unregister(ap.sess.sessionId);
    const bg = await startBackground(t, cwd);
    if (!bg) { asides.delete(t.id); return null; }
    const f2 = T.load(t.id) ?? fresh;
    f2.to = { ...f2.to, sessionId: bg.sess.sessionId, name: bg.sess.name };
    if (f2.transcriptOwner === ap.sess.sessionId) f2.transcriptOwner = bg.sess.sessionId;
    T.save(f2);
    bg.origin = origin;
    Ap.stdinTurn(bg, withTranscript(f2, bg.sess.sessionId, Ap.firstTurn(f2, bg.sess.sessionId, Ap.cliCommand(), cwd, copy ? origin : undefined)));
    for (const x of ap.queue) Ap.stdinTurn(bg, x);
    return bg.sess;
  }
  ap.sess = rec;
  ap.ready = true;
  await deliver(rec, first);
  for (const x of ap.queue.splice(0)) await deliver(rec, x);
  log("aside", t.id, "handled in a new window, pid", rec.pid, "in", cwd);
  return rec;
}

/** Where it's handled, said in the Slack thread, which is where both people see it.
 *  The interactive sessions are told nothing more: that's what Edu asked for. */
async function announceWhere(t: T.Thread, sess: SessionRecord | null, cwd: string) {
  const p = bridge(t);
  if (!sess || !p || !hasThread(t)) return;
  const how = asides.get(t.id)?.mode === "window" ? "in a new window" : "in the background";
  const copy = (T.load(t.id) ?? t).copiaDe ? ", on a clean copy" : "";
  const update = await newVersionNotice();
  await p.notice(t, `:desktop_computer: ${Cfg.load().human ?? "here"}: an aside Claude handles it ${how}, in \`${basename(cwd)}\`${copy}.${update ? ` (${update})` : ""}`);
}

const sessById = (id: string) => liveSessions().find(s => s.sessionId === id);

/** Delivers to one side: by socket if it's on this machine, by Slack if not. */
async function sendToSide(t: T.Thread, side: T.Side, text: string, m?: T.Msg): Promise<boolean> {
  const local = sessById(side.sessionId);
  if (local) return send(local, withTranscript(t, side.sessionId, text));
  const p = bridge(t);
  if (p && hasThread(t)) return p.post(t, text, m);
  return false;
}

async function refreshTranscript(t: T.Thread) {
  if (!Cfg.load().transcript) return;
  try {
    const url = await publishTranscript(t);
    if (url && url !== t.transcriptUrl) { t.transcriptUrl = url; T.save(t); }
  } catch (e) { log("transcript-failed", t.id, String(e)); }
}

async function handle(req: Req): Promise<any> {
  switch (req.op) {
    case "ping":
      return { ok: true, pid: process.pid, slack: Boolean(slack), nostr: Boolean(nostr) };

    case "sessions":
      return { ok: true, sessions: liveSessions().map(s => ({ sessionId: s.sessionId, name: s.name, cwd: s.cwd, aparte: s.aparte })) };

    case "open": {
      const me = sessById(req.sessionId);
      if (!me) return { ok: false, error: "this session isn't registered; restart Claude Code with the hook installed" };
      const cfg = Cfg.load();
      const now = Date.now();

      // Remote target: "@sam" goes over Slack. Local target: by session name.
      const remote = typeof req.to === "string" && req.to.startsWith("@");
      let to: T.Side;
      let viaNostr: { pk: string; relays: string[] } | null = null;
      if (remote) {
        if (!slack && !nostr) return { ok: false, error: "neither Slack nor Nostr is set up: run `spoochie join <invite>` or `spoochie slack setup`" };
        // Local contacts first: whoever invited you or whoever you invited. Slack only
        // if they're not there, because looking up by name there needs a scope that may be missing.
        const u = Cfg.contact(cfg, req.to.slice(1)) ?? (slack ? await slack.lookupUser(req.to.slice(1)) : null);
        if (!u) return { ok: false, error: `can't find ${req.to}: not in your spoochie contacts${slack ? " or in Slack" : ""}` };
        // With a Nostr key on both sides, it goes over Nostr (encrypted, no server); Slack
        // stays for notifications. With --transport slack, or without a key, it goes over Slack.
        const otherNpub = (u as any).npub as string | undefined;
        if (nostr && otherNpub && cfg.transporte !== "slack") {
          viaNostr = { pk: otherNpub, relays: (u as any).relays ?? DEFAULT_RELAYS };
          to = { sessionId: `nostr:${otherNpub}`, name: u.name, cwd: "(otra maquina)", human: u.name, slackUser: u.id.startsWith("nostr:") ? undefined : u.id };
        } else {
          if (!slack) return { ok: false, error: `${req.to} has no Nostr key in your contacts and there's no Slack here: ask them to join with your invite` };
          to = { sessionId: `slack:${u.id}`, name: u.name, cwd: "(otra maquina)", human: u.name, slackUser: u.id };
        }
      } else {
        const matches = findSession(req.to).filter(s => s.sessionId !== req.sessionId);
        if (matches.length === 0) return { ok: false, error: `can't find any live session matching "${req.to}"` };
        if (matches.length > 1) return { ok: false, error: `"${req.to}" matches several`, candidates: matches.map(s => `${s.name} (${s.cwd})`) };
        const m = matches[0];
        to = { sessionId: m.sessionId, name: m.name, cwd: m.cwd };
      }

      // `--follow <id>`: this spoochie continues an earlier one. Only what survives the
      // deletion on close is inherited (subject, with whom, when and why it closed):
      // the text was deleted on purpose and won't come back through the back door. What
      // the receiver gains is knowing they don't start from scratch.
      let follows: { id: string; subject: string; closedAt?: number; closeReason?: string } | null = null;
      if (req.seguir) {
        const old = T.load(String(req.seguir));
        if (!old) return { ok: false, error: `there's no spoochie ${req.seguir} on this machine` };
        if (!T.isParty(old, req.sessionId) && old.from.sessionId !== req.sessionId && old.to.sessionId !== req.sessionId) {
          return { ok: false, error: `spoochie ${req.seguir} isn't yours` };
        }
        follows = { id: old.id, subject: old.subject, closedAt: old.closedAt, closeReason: old.closeReason };
      }

      const body = follows
        ? `${req.body}\n\n[Continues spoochie ${follows.id}, "${follows.subject}", which closed${follows.closedAt ? ` on ${new Date(follows.closedAt).toISOString().slice(0, 16).replace("T", " ")}` : ""}${follows.closeReason ? ` because: ${follows.closeReason}` : ""}. What was said there was deleted on close; only the thread it came from carries over.]`
        : req.body;

      const t: T.Thread = {
        id: T.newId(),
        subject: req.subject ?? (follows ? follows.subject : undefined),
        sigue: follows?.id,
        grupo: req.grupo,
        from: { sessionId: me.sessionId, name: me.name, cwd: me.cwd, human: cfg.human, slackUser: cfg.slack?.userId },
        to,
        state: "pending",
        createdAt: now,
        lastActivityAt: now,
        context: req.context ?? {},
        messages: [{ at: now, from: me.sessionId, author: req.author ?? "claude", kind: req.kind ?? "text", text: body, files: req.files }],
      };

      if (remote && viaNostr && nostr) {
        const ok = await nostr.openThread(t, viaNostr.pk, viaNostr.relays);
        if (!ok) return { ok: false, error: "couldn't publish the invite on any Nostr relay" };
        // Slack notifies the person, if we know them through Slack: the thread doesn't live there.
        if (slack && to.slackUser) void slack.noticeDm(to.slackUser, `${cfg.human ?? me.name} opened a spoochie with you over Nostr: "${t.subject}". The notice pops up on your Mac; the conversation is encrypted and doesn't go through Slack.`);
      } else if (remote && slack) {
        const th = await slack.openThread(t);
        if (!th) return { ok: false, error: "couldn't open the thread in Slack" };
        t.slack = th;
        t.transporte = "slack";
      }
      T.save(t);
      await refreshTranscript(t);

      // Whoever opens publishes the transcript: the Artifact is theirs.
      if (Cfg.load().transcript) { t.transcriptOwner = me.sessionId; T.save(t); }
      const delivered = remote ? true : await sendToSide(t, t.to, T.renderInvite(t, t.to.sessionId));
      log("open", t.id, me.name, "->", to.name, delivered ? "delivered" : "FAILED");
      Aud.record("abierto", t.id, cfg.human ?? me.name, `-> ${to.human ?? to.name} · ${t.subject}`);
      return { ok: true, id: t.id, to: to.name, delivered, transcript: t.transcriptUrl };
    }

    /** The Q3 gate. The receiving human opens it, not their Claude.
     *  What makes it real is Claude Code's own permission system:
     *  `spoochie accept` must not be in the allowlist, so running it brings up
     *  the permission dialog and the person is the one who approves it. */
    case "accept": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} doesn't exist` };
      if (t.state === "closed") return { ok: false, error: `spoochie ${req.id} is closed (${t.closeReason})` };
      if (t.state === "open") return { ok: true, id: t.id, already: true };
      if (t.to.sessionId !== req.sessionId) return { ok: false, error: "only the side receiving the invite can accept it" };
      t.state = "open";
      t.acceptedAt = Date.now();
      t.acceptedBy = req.by ?? "receiving human";
      t.lastActivityAt = t.acceptedAt;
      T.save(t);
      await sendToSide(t, t.from, T.renderAccepted(t, t.from.sessionId));
      // By default the conversation doesn't go into the session that accepted: an aside
      // Claude in the same directory handles it. --here leaves it where it is.
      const me = sessById(req.sessionId);
      let asideCwd: string | undefined;
      if (Cfg.load().aparte !== false && !req.aqui && me && !me.aparte && !t.from.sessionId.startsWith(me.sessionId)) {
        // Don't wait for it to start. Nothing else reaches this session: the answer
        // to this command is the last it sees of the spoochie.
        asideCwd = me.cwd;
        void attend(t, me.cwd).then(s => announceWhere(t, s, me.cwd));
      }
      await refreshTranscript(t);
      log("accept", t.id, "by", t.acceptedBy, asideCwd ? `aside in ${asideCwd}` : "here");
      return { ok: true, id: t.id, state: t.state, aparte: asideCwd, ventana: asideCwd ? Ap.asideMode() === "window" : undefined };
    }

    case "say": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} doesn't exist` };
      if (t.state === "closed") return { ok: false, error: `spoochie ${req.id} is closed (${t.closeReason})` };
      if (!T.isParty(t, req.sessionId)) return { ok: false, error: `this session isn't part of spoochie ${req.id}` };
      if (t.state === "pending") {
        return t.to.sessionId === req.sessionId
          ? { ok: false, error: `the tunnel isn't open. Ask your human and, if they accept, run: spoochie accept ${t.id}` }
          : { ok: false, error: `the other side hasn't accepted the tunnel yet` };
      }

      if (!String(req.text ?? "").trim()) return { ok: false, error: "an empty message isn't sent" };
      const now = Date.now();
      const m: T.Msg = {
        at: now, from: req.sessionId,
        author: req.author ?? "claude",
        kind: req.kind ?? "text",
        text: req.text, files: req.files,
      };
      t.messages.push(m);
      t.lastActivityAt = now;
      t.avisado = false;
      T.save(t);

      const other = T.otherSide(t, req.sessionId);
      // "delivered" has to be a checked fact, not the intention to send.
      // When it goes out over Slack the send is delayed, so it says "encolado" (queued):
      // saying "delivered" before it goes out is exactly the lie that makes
      // nobody trust a channel.
      let delivered: boolean | "encolado" | "publicado" | "retenido";
      if (sessById(other.sessionId)) {
        // The other side is on this machine: here we are the receiver, and the watcher
        // looks before it enters their session.
        delivered = await watch(t, m) ? await sendToSide(t, other, T.renderMessage(t, m, other.sessionId), m) : "retenido";
      } else {
        // It goes out over Slack with a small delay (the queue merges messages in a row). We wait
        // for it to actually go out, up to 8 s, so we can say "publicado" (posted) and not "encolado":
        // in the first real test the sending Claude read "encolado" as "stuck" and
        // closed the tunnel, giving up on messages that had gone out in 3 s.
        let signalSent: (ok: boolean) => void = () => {};
        const sent = new Promise<boolean>(r => { signalSent = r; });
        enqueue(t, m, async (tt, mm) => {
          const peer = T.otherSide(tt, req.sessionId);
          const ok = await sendToSide(tt, peer, T.renderMessage(tt, mm, peer.sessionId), mm);
          log("out", tt.id, ok ? `posted ${via(tt)}` : "FAILED to post");
          signalSent(ok);
          if (ok) await bridge(tt)?.thinkingOn(tt, peer.human ?? peer.name);
          if (!ok) {
            const me = sessById(T.mySide(tt, req.sessionId).sessionId);
            if (me) await send(me, `[spoochie ${tt.id}] your message did NOT go out to Slack. Don't assume they've read it.`);
          }
        });
        const result = await Promise.race([sent, new Promise<null>(r => setTimeout(() => r(null), 8_000))]);
        delivered = result === true ? "publicado" : result === false ? false : "encolado";
      }
      await refreshTranscript(t);
      log("say", t.id, req.sessionId, m.kind, m.offTopic?.verdict ?? "-", delivered ? "delivered" : "FAILED");
      return { ok: true, id: t.id, state: t.state, delivered, offTopic: m.offTopic, transcript: t.transcriptUrl };
    }

    /**
     * Remove someone from the contacts.
     *
     * Without a server there is no global revocation, and there won't be: each machine decides
     * who it knows. What can be done, and couldn't before, is remove them from yours in
     * one go: close whatever you have open with that person, remove them entirely (key
     * included) and keep whatever arrives afterwards out, because since 0.9.9 an envelope from an
     * id that isn't in the contacts is dropped.
     */
    case "olvidar": {
      const c = Cfg.load();
      const who = String(req.quien ?? "").replace(/^@/, "");
      const key = Cfg.contactKey(who);
      const x = c.contacts?.[key];
      if (!x) return { ok: false, error: `"${who}" isn't in your contacts` };
      const theirs = T.all().filter(t => t.state !== "closed" && (t.from.slackUser === x.id || t.to.slackUser === x.id || t.nostr?.otro === x.npub));
      for (const t of theirs) await closeThread(t, req.motivo ?? `${x.name} removed from contacts`, req.sessionId);
      delete c.contacts![key];
      Cfg.save(c);
      Aud.record("confianza", "-", Cfg.load().human ?? "this machine", `forgot ${x.name} (${x.id})${req.motivo ? ` · ${req.motivo}` : ""}`);
      log("forget", x.id, x.name, `${theirs.length} spoochies closed`);
      return { ok: true, quien: x.name, cerrados: theirs.map(t => t.id) };
    }

    // Close the N tunnels of the same question in one go. Each one closes like
    // any other: the other side is told and it's deleted. The group only bundles them.
    case "close-grupo": {
      const group = String(req.grupo ?? "");
      if (!group) return { ok: false, error: "the group is missing" };
      const theirs = T.all().filter(t => t.grupo === group && t.state !== "closed" && T.isParty(t, req.sessionId));
      if (!theirs.length) return { ok: false, error: `there's no open spoochie in group ${group}` };
      for (const t of theirs) await closeThread(t, req.reason ?? "group closed", req.sessionId);
      return { ok: true, grupo: group, cerrados: theirs.map(t => t.id) };
    }

    case "close": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} doesn't exist` };
      if (t.state === "closed") return { ok: true, id: t.id, already: true };
      if (req.sessionId && !T.isParty(t, req.sessionId)) return { ok: false, error: `this session isn't part of spoochie ${req.id}` };
      await closeThread(t, req.reason ?? "closed by hand", req.sessionId);
      return { ok: true, id: t.id };
    }

    case "list": {
      const mine = req.sessionId ? T.activeFor(req.sessionId) : T.all();
      return {
        ok: true,
        threads: mine.map(t => ({
          id: t.id, subject: t.subject, state: t.state,
          from: t.from.human ?? t.from.name, to: t.to.human ?? t.to.name,
          messages: t.messages.length, transcript: t.transcriptUrl,
          expiresInSec: t.state === "closed" ? null : Math.round(((T.expiresAt(t) ?? 0) - Date.now()) / 1000),
        })),
      };
    }

    case "search": {
      return {
        ok: true,
        hits: T.search(req.q).map(h => ({
          id: h.t.id, subject: h.t.subject, state: h.t.state, donde: h.donde,
          con: (h.t.from.human ?? h.t.from.name) + " and " + (h.t.to.human ?? h.t.to.name),
          cuando: new Date(h.t.createdAt).toISOString().slice(0, 16).replace("T", " "),
          rama: h.t.context.branch,
          extracto: h.msg ? T.snippet(h.msg.text, req.q) : undefined,
          transcript: h.t.transcriptUrl,
        })),
      };
    }

    case "get": {
      const t = T.load(req.id);
      return t ? { ok: true, thread: t } : { ok: false, error: `spoochie ${req.id} doesn't exist` };
    }

    /** The SessionEnd hook: closing the screen closes your live spoochies. */
    case "session-end": {
      const closed: string[] = [];
      const why = String(req.sessionId).startsWith("aparte-") ? "the aside Claude's window was closed" : "the other session closed";
      for (const t of T.activeFor(req.sessionId)) {
        await closeThread(t, why, req.sessionId);
        closed.push(t.id);
      }
      return { ok: true, closed };
    }

    /** Q7: if the spoochie arrived while there was no live session, it is delivered as soon
     *  as a matching one starts. The queue lasts as long as the 4h clock.
     *  Matching isn't "being the first to start": the envelope's branch has to
     *  exist in its checkout. If not, it stays queued for another session. */
    case "claim": {
      const me = sessById(req.sessionId);
      if (!me) return { ok: false, error: "session not registered" };
      const claimed: string[] = [];
      for (const t of T.all()) {
        if (await assign(t) === me.sessionId) claimed.push(t.id);
      }
      return { ok: true, claimed };
    }

    /** When several sessions are open, the person says which one takes it. */
    case "take": {
      const me = sessById(req.sessionId);
      if (!me) return { ok: false, error: "session not registered" };
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} doesn't exist` };
      if (t.state === "closed") return { ok: false, error: `spoochie ${req.id} is closed` };
      const current = t.state === "open" && !T.isRemote(t.to.sessionId) ? sessById(t.to.sessionId) : undefined;
      // An aside can be moved to another repo with take; another live interactive session can't.
      if (current && !current.aparte) return { ok: false, error: `spoochie ${req.id} is already handled by ${t.to.name}` };
      // Taking it from a session fixes the directory. If it's already accepted and an aside
      // Claude is due, it's launched there (or the existing one is kept if it's the same repo); if not, the
      // invite goes into the session so the human can accept, and the aside is born on accept.
      if (t.state === "open" && Cfg.load().aparte !== false && !req.aqui) {
        const curAside = asides.get(t.id);
        const same = (curAside?.origin ?? curAside?.cwd) === me.cwd && current?.aparte;
        void attend(t, me.cwd).then(s => { if (!same) return announceWhere(t, s, me.cwd); });
        log("take", t.id, "->", me.name, same ? "already was in" : "aside in", me.cwd);
        return { ok: true, id: t.id, aparte: me.cwd, already: Boolean(same), ventana: Ap.asideMode() === "window" };
      }
      if (current?.aparte) {
        // --here on a spoochie an aside was handling: the aside says goodbye.
        const ap = asides.get(t.id) ?? { id: t.id, cwd: current.cwd, mode: "window" as const, sess: current, queue: [], ready: true, dead: false };
        asides.delete(t.id);
        await dismiss(ap, `session ${me.name} handles it now`);
      }
      t.to = { ...t.to, sessionId: me.sessionId, name: me.name, cwd: me.cwd, human: Cfg.load().human ?? t.to.human };
      T.save(t);
      await send(me, t.state === "open" ? T.renderAccepted(t, me.sessionId) : T.renderInvite(t, me.sessionId));
      log("take", t.id, "->", me.name);
      return { ok: true, id: t.id };
    }

    case "release":
    case "discard": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} doesn't exist` };
      const mine = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
      if (req.sessionId && req.sessionId !== mine) return { ok: false, error: "only the receiving side can release what was held" };
      const n = await release(t, req.op === "release" ? "suelta" : "descarta", "from the CLI");
      return { ok: true, id: t.id, [req.op === "release" ? "released" : "discarded"]: n };
    }

    case "transcript-url": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} doesn't exist` };
      // This URL ends up posted in the other person's thread. The aside has
      // `spoochie transcript` on its allowlist, so without this it was a way for
      // data out of a machine whose Claude is read-only.
      const v = T.transcriptUrlOf(req.url);
      if (!v.ok) return { ok: false, error: v.error };
      req.url = v.url;
      t.transcriptUrl = v.url;
      t.transcriptOwner = req.sessionId ?? t.transcriptOwner;
      t.transcriptStale = 0;
      T.save(t);
      if (hasThread(t)) await bridge(t)?.post(t, `Live transcript: ${req.url}`);
      return { ok: true, id: t.id, url: req.url };
    }

    case "slack-reload": {
      slack = SlackBridge.fromConfig(onSlackMessage, onSlackAccept, onRemoteAccept, (t, o) => release(t, o, "from Slack").then(() => {}), onRemoteClose);
      hookRotation();
      startNostr();
      return { ok: true, slack: Boolean(slack), nostr: Boolean(nostr) };
    }

    default:
      return { ok: false, error: `unknown op: ${req.op}` };
  }
}

/**
 * Which local session gets a spoochie that comes from outside.
 *
 * Always ONE, and with the whole invite. The previous version, with several sessions
 * and no matching branch, sent all of them a "there are several, do take" line without the
 * message: in the first real test the question reached no terminal, and the Claude in
 * the wrong terminal did take on its own. Order: the envelope's branch exists in
 * the checkout; the subject or the first message names the directory; and otherwise, the
 * session where the person last typed.
 */
function pickSession(t: T.Thread): { pick: SessionRecord | null; others: number } {
  // An aside Claude handles a single spoochie: it's never a candidate for another.
  const live = liveSessions().filter(s => !s.aparte);
  if (live.length === 0) return { pick: null, others: 0 };
  const others = live.length - 1;
  const byBranch = live.filter(s => repoMatches(s.cwd, t.context.branch));
  if (byBranch.length) return { pick: byBranch[0], others };
  const text = `${t.subject}\n${t.messages[0]?.text ?? ""}`.toLowerCase();
  const byName = live.filter(s => { const b = basename(s.cwd).toLowerCase(); return b.length >= 3 && text.includes(b); });
  if (byName.length) return { pick: byName[0], others };
  return { pick: live[0], others };
}

/** Which way an envelope went out, for the log. It said "posted in Slack" for Nostr too, and
 *  in the 01-10 real test that sent people looking for the answer in the wrong place. */
const via = (t: T.Thread) => t.transporte === "nostr" ? "via Nostr" : "in Slack";

/** The open notice dialogs, by spoochie: one per spoochie, and they close on their own
 *  if the tunnel is accepted from Slack or gets closed. */
const dialogs = new Map<string, { close: () => void }>();

/**
 * The notice queue. One on screen, and that's it.
 *
 * Every pending spoochie popped its window as soon as it arrived. Measured with twenty-five
 * envelopes in a row from one contact: twenty-five threads and twenty-five windows at
 * once, all floating in the middle and all stealing focus with
 * `activateIgnoringOtherApps`. The machine is unusable until you clear them.
 *
 * And that's not the worst part. The quick way to clear a stack of modal windows is
 * to hammer Return, and this window's Return is the accept button. So the flood
 * turns the accept button into the emergency exit. It takes the account of
 * someone already in your contacts, which is exactly the most expensive attacker there is.
 *
 * With the queue, the twenty-fifth window doesn't exist until you've answered the
 * first, and each one is read with a clear head.
 */
const queue: { id: string; sessionId: string }[] = [];

function queueNotice(t: T.Thread, pick: SessionRecord) {
  if (dialogs.has(t.id) || queue.some(x => x.id === t.id)) return;
  if (dialogs.size > 0) {
    queue.push({ id: t.id, sessionId: pick.sessionId });
    log("notice", t.id, `queued (${queue.length} waiting)`);
    return;
  }
  askWithDialog(t, pick);
}

/** The next one in the queue, if it still makes sense to ask it. */
function nextNotice() {
  while (queue.length && dialogs.size === 0) {
    const x = queue.shift()!;
    const t = T.load(x.id);
    // While it waited it may have been accepted in Slack, rejected or expired.
    if (!t || t.state !== "pending") continue;
    const s = sessById(x.sessionId) ?? sessById(t.to.sessionId);
    if (!s) continue;
    askWithDialog(t, s);
    return;
  }
}

/** Assigns the spoochie to the session it belongs to and tells the person. On macOS the notice
 *  is a system dialog and the session sees nothing: it only lends its directory to the
 *  aside Claude. Without a desktop, the invite goes into that session as before. */
async function assign(t: T.Thread): Promise<string | null> {
  if (t.state !== "pending" || !T.isRemote(t.to.sessionId)) return null;
  // Whoever opened the tunnel isn't the recipient: if it dealt it to itself, it would
  // overwrite the other side's name and the transcript would say "Sam and Sam".
  const me = Cfg.load().slack?.userId;
  if (me && t.from.slackUser === me) return null;
  const { pick, others } = pickSession(t);
  if (!pick) return null;
  t.to = { ...t.to, sessionId: pick.sessionId, name: pick.name, cwd: pick.cwd, human: Cfg.load().human ?? t.to.human };
  T.save(t);
  // Permanent, scoped consent: this person, this repo. No dialog, but
  // not silent: it's said in the thread, which is where the person sees it later.
  if (Conf.autoAccepts(Cfg.load(), { slackUser: t.from.slackUser, npub: t.nostr?.otro }, pick.cwd)) {
    log("assign", t.id, "-> accepted on its own (trust in", Conf.repoName(pick.cwd) + ")");
    if (bridge(t) && hasThread(t)) await bridge(t)!.notice(t, `:key: accepted without asking: you have set spoochies from ${t.from.human ?? t.from.name} about *${Conf.repoName(pick.cwd)}* to come in on their own. Undo it with \`spoochie trust ${t.from.human ?? t.from.name} --repo ${Conf.repoName(pick.cwd)} --remove\`.`);
    Aud.record("aceptado-solo", t.id, Cfg.load().human ?? "this machine", `from ${t.from.human ?? t.from.name} · repo ${Conf.repoName(pick.cwd)}`);
    await onSlackAccept(t, "by permanent consent");
    return pick.sessionId;
  }
  if (Dlg.noticeMode() === "dialog") {
    queueNotice(t, pick);
    log("assign", t.id, "-> dialog, repo of", pick.name);
    return pick.sessionId;
  }
  const extra = others ? `\nIf this is for another session of yours (there are ${others} more open), your human says so and from there:  spoochie take ${t.id}` : "";
  await send(pick, T.renderInvite(t, pick.sessionId) + extra);
  log("assign", t.id, "->", pick.name, others ? `(${others} more sessions)` : "");
  return pick.sessionId;
}

/**
 * We considered launching the aside RIGHT AWAY, while the dialog waits, so the answer
 * would be ready on accept. REJECTED, for two reasons that can't be fixed:
 *
 * 1. It spends your money on a question you haven't accepted. Half the spoochies that
 *    get rejected are rejected because they weren't for you, and those would have paid for a whole model
 *    reading a repo for nothing.
 * 2. It breaks the sentence everything else rests on. "Nothing happens until you accept" stops
 *    being true if a Claude is already reading your repo because of someone else's question. It doesn't matter
 *    that nothing goes out through the tunnel: the promise was that it doesn't start, not that it isn't
 *    delivered.
 *
 * The right way for the daemon to "work" already exists and is different: the aside keeps
 * working after accept even if you don't look, and if an answer was left unread
 * at close you're told (`warnUnread`).
 */
function askWithDialog(t: T.Thread, pick: SessionRecord) {
  const notice = Dlg.ask(t);
  dialogs.set(t.id, notice);
  void notice.answer.then(async r => {
    if (dialogs.get(t.id) === notice) dialogs.delete(t.id);
    // Whatever happens with this one, the next in the queue can now go.
    setTimeout(nextNotice, 0).unref?.();
    const fresh = T.load(t.id);
    log("notice", t.id, "dialog:", r ?? "no answer");
    // While the dialog was open it may have been accepted in Slack or expired: the state rules.
    if (!fresh || fresh.state !== "pending") return;
    if (r === "accept") { Aud.record("aceptado", fresh.id, Cfg.load().human ?? "this machine", "in the dialog"); await onSlackAccept(fresh, "in the notice"); }
    else if (r === "decline") { Aud.record("rechazado", fresh.id, Cfg.load().human ?? "this machine", "in the dialog"); await closeThread(fresh, `rejected by ${Cfg.load().human ?? "the person"}`, pick.sessionId); }
    else if (r === "slack" && fresh.slack) Dlg.openInSlack(slack ? await slack.teamId() : null, fresh.slack.channel, fresh.slack.ts);
  });
}

function closeDialog(id: string) {
  const i = queue.findIndex(x => x.id === id);
  if (i >= 0) queue.splice(i, 1);
  const d = dialogs.get(id);
  if (d) { dialogs.delete(id); try { d.close(); } catch {} setTimeout(nextNotice, 0).unref?.(); }
}

/** Accepting by writing in the Slack thread. Does the same as `spoochie accept`. */
async function onSlackAccept(t: T.Thread, by: string) {
  // The bridge may bring a stale thread: "ok" and then "go on" in the same
  // tick posted "has accepted" twice. The fresh state is checked.
  if ((T.load(t.id) ?? t).state !== "pending") return;
  // The spoochie may not have a local session yet: find it one first.
  if (T.isRemote(t.to.sessionId)) await assign(t);
  const fresh = T.load(t.id) ?? t;
  fresh.state = "open";
  fresh.acceptedAt = Date.now();
  fresh.acceptedBy = Cfg.load().human ?? by;
  fresh.lastActivityAt = fresh.acceptedAt;
  T.save(fresh);
  closeDialog(fresh.id);
  await sendToSide(fresh, fresh.from, T.renderAccepted(fresh, fresh.from.sessionId));
  const local = sessById(fresh.to.sessionId);
  if (local && !local.aparte) {
    if (Cfg.load().aparte !== false && !fresh.from.sessionId.startsWith(local.sessionId)) {
      // With the notice as a dialog, the session never knew about the spoochie and there's nothing to
      // tell it. With the invite in the terminal there is: one line, and it's the last it sees;
      // without it its Claude is left with "do you accept?" hanging and runs accept or take.
      if (Dlg.noticeMode() !== "dialog") await send(local, `[spoochie ${fresh.id} | ${fresh.subject}] your human accepted it ${by}. An aside Claude handles it in a new window; nothing else reaches this session. Don't run accept or take.`);
      void attend(fresh, local.cwd).then(s => announceWhere(fresh, s, local.cwd));
    } else {
      await send(local, `[spoochie ${fresh.id} | ${fresh.subject}] your human has accepted it ${by}. The tunnel is open: you can answer with  spoochie say ${fresh.id} "<text>"`);
    }
  } else if (!local) {
    // No Claude Code session open on this machine: there's no repo to be born in.
    if (bridge(fresh) && hasThread(fresh)) await bridge(fresh)!.notice(fresh, `:warning: ${Cfg.load().human ?? "the other side"} has no Claude Code session open. The spoochie waits: once one is open in the repo, \`spoochie take ${fresh.id}\`.`);
  }
  await refreshTranscript(fresh);
  log("accept", fresh.id, by, local ? `-> ${local.name}` : "no local session");
}

/** The other side has accepted: whoever opened the tunnel finds out and leaves "pending". */
async function onRemoteAccept(t: T.Thread, by: string) {
  const fresh = T.load(t.id) ?? t;
  if (fresh.state !== "pending") return;
  fresh.state = "open";
  fresh.acceptedAt = Date.now();
  fresh.acceptedBy = fresh.to.human ?? by;
  fresh.lastActivityAt = fresh.acceptedAt;
  T.save(fresh);
  const local = sessById(fresh.from.sessionId);
  if (local) await send(local, T.renderAccepted(fresh, fresh.from.sessionId));
  await refreshTranscript(fresh);
  log("remote-accept", fresh.id);
}

/** A turn arriving over Slack from another machine, or from a human writing in the thread. */
async function onSlackMessage(t: T.Thread, m: T.Msg) {
  // Closed is closed: whatever arrives late (a slow relay, someone writing in the
  // already-closed Slack thread) doesn't refill a spoochie that was already purged.
  if (t.state === "closed") { log("in", t.id, "message after close; dropped"); return; }
  t.messages.push(m);
  t.lastActivityAt = m.at;
  if (t.state === "pending" && m.author === "human") { t.state = "open"; t.acceptedAt = m.at; t.acceptedBy = "human in Slack"; }
  T.save(t);
  // A freshly discovered spoochie has no local side yet: find it one.
  if (t.state === "pending" && T.isRemote(t.to.sessionId)) {
    const assigned = await assign(t);
    log("slack-in", t.id, m.author, assigned ? "assigned" : "no session to assign to");
    return;
  }
  const mine = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
  const local = sessById(mine);
  if (local && !(await watch(t, m))) {
    log("slack-in", t.id, m.author, "HELD", m.peligro);
    await refreshTranscript(t);
    return;
  }
  if (local) {
    await send(local, withTranscript(t, mine, T.renderMessage(t, m, mine)));
    // As soon as it lands, not at the end: the transcript and the "thinking" took 9 s and in the
    // real test the log said nothing about an answer that was already in the session.
    log("in", t.id, m.author, "in the session");
    // The other side sees that work is happening here, instead of 40 blank seconds.
    await bridge(t)?.thinkingOn(t, T.mySide(t, mine).human ?? T.mySide(t, mine).name);
  }
  await refreshTranscript(t);
  log("slack-in", t.id, m.author, local ? "delivered" : "no local session");
}

/** The watcher, on the receiving side. Returns whether the message may enter.
 *  A message that asks for action stays in the thread, flagged, until the receiving
 *  human releases it; an off-topic one enters with its label and a notice in Slack. */
async function watch(t: T.Thread, m: T.Msg): Promise<boolean> {
  // The other person's turns are checked, whatever their kind. It used to say
  // `m.kind !== "text"`, so a patch or a branch skipped the watcher: whoever
  // sent chose whether they wanted a watcher just by typing `spoochie patch` instead of
  // `spoochie say`. And the watcher exists precisely because the sender needn't be
  // trustworthy. The prompt itself already distinguishes: proposing a patch for a
  // person to review isn't danger; what it looks for inside it is instructions to the assistant.
  if (!Cfg.load().guardian || m.author === "spoochie") return true;
  const v = await judge(t.subject, m.text);
  m.offTopic = { verdict: v.verdict, why: v.why };
  const sender = T.otherSide(t, T.mySide(t, sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId).sessionId);
  if (v.peligro) {
    m.retenido = "si";
    m.peligro = v.why;
    T.save(t);
    const receiver = T.mySide(t, sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId);
    if (bridge(t) && hasThread(t)) await bridge(t)!.notice(t, `:no_entry: *held by the watcher*: ${v.why}. <@${receiver.slackUser ?? ""}> type \`release\` in this thread to deliver it, or \`discard\`.`);
    Aud.record("retenido", t.id, sender.human ?? sender.name, v.why);
    const local = sessById(receiver.sessionId);
    if (local) await send(local, `[spoochie ${t.id} | ${t.subject}] a message from ${sender.human ?? sender.name} is HELD by the watcher: ${v.why}. You haven't received it. Your human decides: "release" or "discard" in the Slack thread, or  spoochie release ${t.id}  /  spoochie discard ${t.id}`);
    return false;
  }
  if (v.verdict !== "dentro") {
    T.save(t);
    // With a high-trust contact the "off topic" label isn't posted: it's
    // noise when you already know who you're talking to, and noise ends with nobody reading the
    // notices that do matter. Holding what asks for action (above) doesn't depend
    // on trust and won't: see trust.ts.
    const quiet = Conf.levelOf(Cfg.load(), { slackUser: sender.slackUser, npub: t.nostr?.otro }) === "alto" && v.verdict !== "sin vigilar";
    if (!quiet && bridge(t) && hasThread(t)) await bridge(t)!.notice(t, v.verdict === "sin vigilar" ? `:grey_question: ${v.why}.` : `:warning: the watcher rates it *${v.verdict === "fuera" ? "off topic" : v.verdict === "dudoso" ? "borderline" : v.verdict}*: ${v.why}`);
  }
  return true;
}

/** What the receiving human decides about what was held. */
async function release(t: T.Thread, action: "suelta" | "descarta", how: string): Promise<number> {
  const mine = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
  const local = sessById(mine);
  let n = 0;
  for (const m of t.messages) {
    if (m.retenido !== "si") continue;
    m.retenido = action === "suelta" ? "suelto" : "descartado";
    n++;
    if (action === "suelta" && local) await send(local, withTranscript(t, mine, T.renderMessage(t, m, mine)));
  }
  if (n) {
    Aud.record(action === "suelta" ? "soltado" : "descartado", t.id, Cfg.load().human ?? "this machine", `${n} message(s) · ${how}`);
    t.lastActivityAt = Date.now();
    T.save(t);
    if (bridge(t) && hasThread(t)) await bridge(t)!.notice(t, action === "suelta" ? `:unlock: ${n} held message(s) delivered ${how}.` : `:wastebasket: ${n} held message(s) discarded ${how}.`);
    await refreshTranscript(t);
  }
  log("held", t.id, action, n, how);
  return n;
}

/** Anyone in the contacts via Slack but without a Nostr key gets mine sent to their
 *  DM. Their daemon stores it and answers with theirs; in one round both have it and
 *  the next spoochie is encrypted. At most once a day per contact (hellos.ts). */
async function shareNostrKey() {
  if (!slack || !nostr) return;
  const c = Cfg.load();
  for (const k of Object.values(c.contacts ?? {})) {
    if (k.npub || !/^[UW][A-Z0-9]{6,}$/.test(k.id) || !helloDue(k.id)) continue;
    const ok = await slack.hello(k.id, nostr.pk, nostr.relays, c.human ?? "someone");
    log("nostr", "key sent over Slack to", k.name, ok ? "ok" : "FAILED");
  }
}

/**
 * Someone outside the contacts tried to talk to me over Nostr. It's always recorded, and the
 * first time in the day for that key it's said with a notification: on 14-09 a real
 * join stayed in the daemon log and nobody saw it. The name is what the
 * envelope says, and it's shown that way, as a claim.
 */
function warnStranger(from: string, x: { kind: string; fromName?: string; slack?: string; motivo?: string }) {
  const first = Strangers.record({ pk: from, kind: x.kind, nombre: x.fromName, slack: x.slack, motivo: x.motivo });
  if (!first) return;
  const name = Strangers.recent().find(d => d.pk === from)?.nombre;
  const what = x.kind === "hola" ? "has joined, but their key didn't make it into your contacts" : "tried to open a spoochie with you, and isn't in your contacts";
  Dlg.notify("spoochie", `${name ? `Someone claiming to be ${name}` : "Someone"} ${what}. See spoochie doctor.`);
}

function startNostr() {
  nostr?.close();
  nostr = NostrBridge.fromConfig({
    onMessage: onSlackMessage, onRemoteAccept, onClose: onRemoteClose, log,
    onStranger: async (from, env) => { warnStranger(from, { kind: env.kind, fromName: env.fromName, slack: env.slack }); },
    onHello: async (from, env, name) => {
      // Someone I invited is in. Only with my invite's nonce, and it's bound
      // to what I recorded when inviting, not to what the hello says (keys.ts).
      const c = Cfg.load();
      const d = helloByNostr(c, { from, name, k: env.k, relays: env.relays });
      if (!d.ok) {
        log("nostr", "hello REJECTED from", name, from.slice(0, 12), d.motivo);
        warnStranger(from, { kind: "hola", fromName: name, slack: env.slack, motivo: d.motivo });
        return;
      }
      Cfg.save(c);
      log("nostr", "hello from", d.name, from.slice(0, 12), d.vinculo);
    },
  }, process.env.SPOOCHIE_NOSTR_DIR ? filePool(process.env.SPOOCHIE_NOSTR_DIR) : undefined);
  nostr?.listen();
  if (slack) {
    slack.onHello = async (from, name, np, r, verdict) => {
      const c = Cfg.load();
      const d = helloBySlack(c, { from, name, np, relays: r, verdict });
      if (!d.ok) { log("nostr", "key over Slack REJECTED:", d.motivo); return; }
      Cfg.save(c);
      log("nostr", "key received over Slack from", d.name, d.vinculo);
      // If they don't have mine, I send it (at most once a day): it converges in one round.
      if (nostr && helloDue(from)) await slack!.hello(from, nostr.pk, nostr.relays, c.human ?? "someone");
    };
  }
  setTimeout(() => { void shareNostrKey(); }, 3000).unref();
}

/** The other side closed: it closes here without telling them again, and gets deleted all the same.
 *  The reason is their text and ends up said inside this session, so it comes in
 *  bounded: see `T.outsideReason`. */
async function onRemoteClose(t: T.Thread, reason: string) {
  reason = T.outsideReason(reason);
  const fresh = T.load(t.id) ?? t;
  if (fresh.state === "closed") return;
  await closeThread(fresh, reason, undefined, true);
}

/** What gets deleted on close, with just enough delay for the other daemon to read the
 *  close before it disappears from the thread (it polls every 4 s). */
const DELETE_REMOTE_AFTER_MS = 45_000;

async function closeThread(t: T.Thread, reason: string, bySession?: string, remote = false) {
  closeDialog(t.id);
  t.state = "closed";
  t.closedAt = Date.now();
  t.closeReason = reason;
  T.save(t);
  const notified: string[] = [];
  for (const side of [t.from, t.to]) {
    if (side.sessionId === bySession) continue;
    // If the other side closed it, the notice isn't sent back to them: only this side learns.
    if (remote && !sessById(side.sessionId)) continue;
    const ok = await sendToSide(t, side, T.renderClose(t));
    notified.push(`${side.name}:${ok ? "delivered" : "FAILED"}`);
  }
  await refreshTranscript(t);
  log("close", t.id, reason, notified.join(" "));
  Aud.record("cerrado", t.id, bySession ? (Cfg.load().human ?? "this machine") : "the clock", reason);

  // Bounded proactivity: facts about the thread, never initiative about the work.
  //
  // The case: the answer reached the aside Claude, which lived in a window you
  // closed, or the spoochie died of silence while you were doing something else. It closes,
  // it's deleted, and nobody tells you there was an answer you didn't read. This proposes
  // nothing and reopens nothing: it says it arrived, from whom, when, and where the transcript is.
  await warnUnread(t, bySession);
  if (Cfg.load().borrarAlCerrar !== false) {
    // Locally, right away: the conversation lives in the Claude that had it, not here.
    T.purge(t, { spool: join(SPOOL, t.id), transcript: transcriptPath(t.id) });
    log("erased", t.id, "local");
    const p = bridge(t);
    if (p && hasThread(t)) {
      setTimeout(async () => { const n = await p.eraseThread(t); log("erased", t.id, t.transporte ?? "slack", n, "posts"); }, DELETE_REMOTE_AFTER_MS).unref();
    }
  }
  const ap = asides.get(t.id);
  if (t.copiaDe) { const [origin, copy] = [t.copiaDe, t.to.cwd]; setTimeout(() => { Ap.removeCopy(origin, copy); log("aside", t.id, "copy removed"); }, 60_000).unref(); }
  if (ap?.mode === "background") setTimeout(() => Ap.killAside(ap), 15_000).unref();
  if (ap?.mode === "window" && ap.ready) { const r = sessById(ap.sess.sessionId); if (r) await send(r, `This spoochie has ended. You can close this window.`); }
  if (ap) asides.delete(t.id);
}

/**
 * If at close there was an answer from the other side left unanswered, it's said once in the
 * session that lent the repo. Before purging, because afterwards the text is gone.
 */
async function warnUnread(t: T.Thread, closedBy?: string) {
  // Only for a tunnel that got opened. If you rejected it, reminding you of the message you
  // rejected is exactly the opposite of respecting the decision.
  if (!t.acceptedAt) return;
  const delivered = t.messages.filter(m => m.retenido !== "si" && m.retenido !== "descartado");
  const last = delivered[delivered.length - 1];
  if (!last) return;
  const mine = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
  if (last.from === mine) return;               // we answered last
  // This same session closed it: the message came in as a turn and closing was its answer.
  // In the 01-10 real test Ana read the number, wrote it down, closed, and got "the
  // last word was Bea's, no reply from you" with the same number below.
  if (closedBy === mine) return;
  const local = sessById(mine);
  if (!local) return;
  // If an aside that's still alive handled it, it has seen it: no need to repeat it.
  const ap = asides.get(t.id);
  if (ap && !ap.dead && ap.sess.sessionId !== mine) return;
  const who = T.otherSide(t, mine);
  const ago = Math.round((Date.now() - last.at) / 60000);
  await send(local, `[spoochie ${t.id}] has closed (${t.closeReason}) and the last thing said was from ${who.human ?? who.name}, ${ago} min ago, with no reply from you:\n\n${(last.text ?? "").slice(0, 400)}\n\n${t.transcriptUrl ? `The whole thread: ${t.transcriptUrl}` : "There's no published transcript of this spoochie."} Tell your human; don't open another spoochie on your own.`);
  log("unread", t.id, who.name, `${ago} min`);
}

/** The Slack bridge is recreated when the config reloads, and each time the rotation
 *  handler has to be hooked up again: without this, a rotation after a
 *  `slack-reload` was applied by nobody and the person was left with the old key. */
function hookRotation() {
  if (!slack) return;
  slack.onRotation = async (from, newPk, verdict) => {
    const c = Cfg.load();
    const { incomingRotation } = await import("./keys.ts");
    const r = incomingRotation(c, from, newPk, verdict);
    if (!r.ok) { log("rotation", from, "rejected:", r.reason); Aud.record("clave-rechazada", "-", from, `rotation: ${r.reason}`); return; }
    Cfg.save(c);
    log("rotation", from, r.nombre, "key changed");
    Aud.record("clave-fijada", "-", r.name, `rotation accepted · before ${r.before.slice(0, 12)}...`);
  };
}

async function tick() {
  const now = Date.now();
  for (const t of T.all()) {
    if (t.state === "closed") continue;
    const due = T.expiresAt(t);
    if (due === null) continue;
    if (now > due) {
      await closeThread(t, t.state === "pending" ? "expired, not accepted within 4h" : "10 min of silence");
      continue;
    }
    // Warn before killing it, instead of letting it vanish without a word.
    if (t.state === "open" && !t.avisado && due - now < T.WARN_BEFORE_MS) {
      t.avisado = true;
      T.save(t);
      for (const side of [t.from, t.to]) {
        const s = sessById(side.sessionId);
        if (s) await send(s, T.renderNotice(t, (due - now) / 1000, side.sessionId));
      }
      log("silence-notice", t.id);
    }
  }
  // What a contact left in the spool of a thread that never existed: the chunks can
  // arrive before the invite, but if the invite never arrives, nobody claims them.
  for (const id of sweepOrphans(id => Boolean(T.load(id)), T.PENDING_TTL_MS)) {
    log("spool-orphan", id, "deleted: 4 h with no thread to claim it");
  }
  if (slack) { try { await slack.poll(); } catch (e) { log("slack-poll-error", String(e)); } }
}


/**
 * Closed spoochies that still keep what was said.
 *
 * "Closing deletes it" is one of the README's three promises, and whoever closes
 * keeps it. But an earlier version could close without sweeping, and those threads stayed
 * there: on a real machine, `spoochie doctor` reported a failure with twelve, from August 30
 * to September 4, with no way to fix it.
 *
 * The rule isn't "deleted on close if that day's version did it": it's that a
 * closed spoochie doesn't keep the text. So they're swept on startup, and with that the
 * machine catches up on its own at the first restart.
 */
function sweepClosedWithText() {
  let n = 0;
  for (const t of T.all()) {
    if (t.state !== "closed" || !t.messages.some(m => (m.text ?? "").length > 0)) continue;
    T.purge(t, { spool: join(SPOOL, t.id), transcript: transcriptPath(t.id) });
    n++;
  }
  if (n) log("sweep", `${n} closed spoochie(s) still kept text from when they closed without sweeping; deleted`);
}

function main() {
  ensureDirs();
  sweepClosedWithText();
  if (alreadyRunning()) { console.error("spoochied is already running"); process.exit(0); }
  if (existsSync(DAEMON_SOCK)) unlinkSync(DAEMON_SOCK);
  writeFileSync(DAEMON_LOCK, String(process.pid));
  // The heartbeat is the only thing that tells a live daemon from a hung one.
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
  slack = SlackBridge.fromConfig(onSlackMessage, onSlackAccept, onRemoteAccept, (t, o) => release(t, o, "from Slack").then(() => {}), onRemoteClose);
  hookRotation();
  startNostr();
  // What an earlier daemon left unsent, and the aside windows that are still alive.
  const resumed = resume(async (tt, mm) => {
    const me = sessById(tt.from.sessionId) ? tt.from : tt.to;
    const other = T.otherSide(tt, me.sessionId);
    const ok = await sendToSide(tt, other, T.renderMessage(tt, mm, other.sessionId), mm);
    log("out", tt.id, ok ? `posted ${via(tt)} (resumed)` : "FAILED to post (will retry)");
    return ok;
  });
  if (resumed) log("queue", "resumed", resumed);
  for (const s of liveSessions()) {
    if (!s.aparte || s.socket === Ap.PENDING_SOCKET || s.socket === "(stdin)") continue;
    const th = T.load(s.aparte);
    asides.set(s.aparte, { id: s.aparte, cwd: s.cwd, mode: "window", sess: s, queue: [], ready: true, dead: false, origin: th?.copiaDe });
    log("aside", s.aparte, "reattached, window pid", s.pid);
  }

  const server = net.createServer(conn => {
    let buf = "";
    conn.on("data", async chunk => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let res: any;
        try { res = await handle(JSON.parse(line)); }
        catch (e) { res = { ok: false, error: String(e) }; }
        conn.write(JSON.stringify(res) + "\n");
      }
    });
    conn.on("error", () => {});
  });

  server.listen(DAEMON_SOCK, () => log("spoochied", VERSION, "listening", DAEMON_SOCK, "pid", process.pid, "slack", Boolean(slack)));

  const loop = () => {
    const live = T.all().some(t => t.state !== "closed" && hasThread(t));
    tick()
      .catch(e => log("tick-error", String(e)))
      .finally(() => setTimeout(loop, live ? TICK_LIVE_MS : TICK_IDLE_MS));
  };
  setTimeout(loop, TICK_LIVE_MS);

  // On exit it cleans up, but ONLY if what's on disk is still mine. An old daemon
  // slow to leave (its parent was killed and it lingers a while) deleted the socket
  // and the lock the new one had just created: a live daemon was left that nobody could
  // call, and the CLI got ENOENT on a file that existed an instant before.
  const bye = () => {
    // The notice is a child osascript and outlived the daemon: it stayed on screen and its
    // accept button no longer reached anyone. Seen in the 01-10 real test.
    for (const d of dialogs.values()) d.close();
    try { if (readFileSync(DAEMON_LOCK, "utf8").trim() === String(process.pid)) { unlinkSync(DAEMON_SOCK); unlinkSync(DAEMON_LOCK); } } catch {}
    process.exit(0);
  };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}

main();
