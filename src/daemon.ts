/**
 * Un demonio por maquina. Es lo unico que sigue vivo entre turnos, asi que es
 * quien lleva los relojes: un Claude solo existe mientras piensa.
 *
 * Enruta entre sesiones locales por el socket de entrada de cada una, y entre
 * maquinas por Slack (src/slack.ts), donde el hilo es a la vez transporte,
 * direccion y fuente de verdad del estado.
 */
import net from "node:net";
import { existsSync, unlinkSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
import { DAEMON_SOCK, DAEMON_LOCK, DAEMON_LOG, ensureDirs } from "./paths.ts";
import { liveSessions, findSession, unregister, type SessionRecord } from "./registry.ts";
import * as T from "./threads.ts";
import { encolar, reanudar } from "./outbox.ts";
import { avisoNueva } from "./actualizacion.ts";
import { VERSION } from "./version.ts";
import { latir, LATIDO_MS } from "./arranque.ts";
import * as Ap from "./aparte.ts";
import * as Dlg from "./dialogo.ts";
import * as Cfg from "./config.ts";
import { deliver } from "./inbox.ts";
import { judge } from "./guardian.ts";
import { publishTranscript, rutaTranscript } from "./transcript.ts";
import { SPOOL } from "./files.ts";
import { join } from "node:path";
import { SlackBridge } from "./slack.ts";
import { NostrBridge, poolDeFichero, pkDe, RELAYS_POR_DEFECTO } from "./nostr.ts";
import { repoMatches } from "./match.ts";

/** Con un tick fijo de 20s, cada salto del tunel se comia hasta 20s de espera y una
 *  conversacion de 6 mensajes acumulaba dos minutos de nada. Mientras hay un spoochie
 *  abierto se mira cada 4s; en reposo, cada 5s: el tick en si no llama a Slack, solo
 *  decide si toca descubrir (cadenciaDescubrir), asi que no cuesta nada. */
const TICK_IDLE_MS = 5_000;
const TICK_VIVO_MS = 4_000;

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
/** El puente por el que va un hilo con otra maquina. */
const puente = (t: T.Thread) => (t.transporte === "nostr" ? nostr : slack) as (SlackBridge | NostrBridge | null);
const tieneHilo = (t: T.Thread) => Boolean(t.transporte === "nostr" ? t.nostr : t.slack);

/** Pega la peticion de republicar el transcript al turno que ya va para esa sesion. */
function conTranscript(t: T.Thread, sessionId: string, texto: string): string {
  if (!Cfg.load().transcript) return texto;
  const tarea = T.tareaTranscript(t, sessionId, rutaTranscript(t.id));
  return tarea ? texto + "\n" + tarea : texto;
}

async function send(sess: SessionRecord | undefined, text: string) {
  if (!sess) return false;
  const ap = sess.aparte ? apartes.get(sess.aparte) : undefined;
  if (ap) {
    // En segundo plano el aparte recibe por su entrada estandar, que es del demonio.
    if (ap.modo === "fondo") return Ap.vivo(ap) ? Ap.turnoStdin(ap, text) : false;
    // La ventana aun no se ha registrado: se le guarda. Nada cae en otra sesion.
    if (!ap.listo) { ap.cola.push(text); return true; }
  }
  try { await deliver(sess, text); return true; }
  catch (e) { log("deliver-failed", sess.sessionId, String(e)); return false; }
}

/** Los Claudes aparte vivos, por id de spoochie. */
const apartes = new Map<string, Ap.Aparte>();
/** Lanzamientos en curso, para que dos accept/take a la vez no abran dos ventanas. */
const atendiendo = new Map<string, Promise<SessionRecord | null>>();

/** Lanza (o reutiliza) el Claude aparte de un spoochie en ese directorio y se lo asigna. */
function atender(t: T.Thread, cwd: string): Promise<SessionRecord | null> {
  const enCurso = atendiendo.get(t.id);
  if (enCurso) return enCurso;
  const p = atenderDeVerdad(t, cwd).catch(e => { log("aparte", t.id, "fallo:", String(e)); return null; }).finally(() => atendiendo.delete(t.id));
  atendiendo.set(t.id, p);
  return p;
}

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Arranca un `claude -p` y comprueba que no muere en el acto. */
async function arrancarFondo(t: T.Thread, cwd: string): Promise<Ap.Aparte | null> {
  const ap = Ap.lanzar(t, cwd, "fondo");
  if (!ap) return null;
  apartes.set(t.id, ap);
  ap.child!.on("error", e => log("aparte", t.id, "no arranca:", String(e)));
  ap.child!.on("exit", code => { if (apartes.get(t.id) === ap) apartes.delete(t.id); unregister(ap.sess.sessionId); log("aparte", t.id, "termino", code); });
  await dormir(300);
  if (ap.child!.exitCode !== null) { log("aparte", t.id, "no arranca; mira", `${Ap.APARTE_DIR}/${t.id}.log`); apartes.delete(t.id); unregister(ap.sess.sessionId); return null; }
  return ap;
}

/** Espera a que el hook SessionStart de la ventana escriba su registro con socket. */
async function esperarVentana(ap: Ap.Aparte, ms: number): Promise<SessionRecord | undefined> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const real = Ap.registroVentana(ap, liveSessions());
    if (real) return real;
    await dormir(500);
  }
  return undefined;
}

/** La ventana vieja se entera de que el spoochie se ha ido a otro sitio. */
async function despedir(ap: Ap.Aparte, porque: string) {
  if (ap.modo === "fondo") { Ap.matar(ap); return; }
  const real = Ap.registroVentana(ap, liveSessions());
  if (real) { try { await deliver(real, `[spoochie ${ap.id}] ${porque}. Esta ventana ya no atiende nada: puedes cerrarla.`); } catch {} }
  unregister(ap.sess.sessionId);
}

async function atenderDeVerdad(t: T.Thread, cwd: string): Promise<SessionRecord | null> {
  const viejo = apartes.get(t.id);
  // Ya hay uno vivo en ese mismo repo: no se relanza. Es lo que pasaba en e856, donde
  // dos accept seguidos mataron al primero y el segundo nacio en el repo equivocado.
  if (viejo && Ap.vivo(viejo) && (viejo.origen ?? viejo.cwd) === cwd && sessById(viejo.sess.sessionId)) { log("aparte", t.id, "ya vivo en", cwd); return viejo.sess; }
  if (viejo) { apartes.delete(t.id); await despedir(viejo, `pasa a atenderse desde ${cwd}`); }

  // Sobre una copia limpia del repo, no sobre el checkout de la persona.
  const origen = cwd;
  const copia = Cfg.load().aparteCopia !== false ? Ap.copiaDeTrabajo(origen, t.id) : null;
  if (Cfg.load().aparteCopia !== false && !copia) log("aparte", t.id, "sin copia (no es un repo git o fallo el worktree); en el checkout");
  cwd = copia ?? origen;
  let ap = Ap.modo() === "ventana" ? Ap.lanzar(t, cwd, "ventana") : null;
  if (ap) apartes.set(t.id, ap);
  else {
    if (Ap.modo() === "ventana") log("aparte", t.id, "no pude abrir una ventana; va en segundo plano");
    ap = await arrancarFondo(t, cwd);
    if (!ap) return null;
  }
  ap.origen = origen;

  // El spoochie apunta al aparte desde ya: lo que llegue mientras arranca se le guarda
  // a el, no entra en la sesion donde trabaja la persona.
  const fresco = T.load(t.id) ?? t;
  fresco.to = { ...fresco.to, sessionId: ap.sess.sessionId, name: ap.sess.name, cwd, human: Cfg.load().human ?? fresco.to.human };
  fresco.copiaDe = copia ? origen : undefined;
  // Un spoochie que llega de fuera no tenia quien publicara su transcript: el demonio no
  // puede, y la sesion interactiva no debe verlo. El aparte es una sesion de Claude: lo hace el.
  if (Cfg.load().transcript && !fresco.transcriptOwner) fresco.transcriptOwner = ap.sess.sessionId;
  T.save(fresco);
  const primero = conTranscript(fresco, ap.sess.sessionId, Ap.primerTurno(fresco, ap.sess.sessionId, Ap.comandoCli(), cwd, copia ? origen : undefined));

  if (ap.modo === "fondo") {
    Ap.turnoStdin(ap, primero);
    log("aparte", t.id, "atendido en segundo plano en", cwd);
    return ap.sess;
  }

  const real = await esperarVentana(ap, 60_000);
  if (!real) {
    log("aparte", t.id, "la ventana no se registro en 60 s (¿plugin viejo en esa sesion?); sigo en segundo plano");
    unregister(ap.sess.sessionId);
    const fondo = await arrancarFondo(t, cwd);
    if (!fondo) { apartes.delete(t.id); return null; }
    const f2 = T.load(t.id) ?? fresco;
    f2.to = { ...f2.to, sessionId: fondo.sess.sessionId, name: fondo.sess.name };
    if (f2.transcriptOwner === ap.sess.sessionId) f2.transcriptOwner = fondo.sess.sessionId;
    T.save(f2);
    fondo.origen = origen;
    Ap.turnoStdin(fondo, conTranscript(f2, fondo.sess.sessionId, Ap.primerTurno(f2, fondo.sess.sessionId, Ap.comandoCli(), cwd, copia ? origen : undefined)));
    for (const x of ap.cola) Ap.turnoStdin(fondo, x);
    return fondo.sess;
  }
  ap.sess = real;
  ap.listo = true;
  await deliver(real, primero);
  for (const x of ap.cola.splice(0)) await deliver(real, x);
  log("aparte", t.id, "atendido en una ventana nueva, pid", real.pid, "en", cwd);
  return real;
}

/** Donde se atiende, dicho en el hilo de Slack, que es donde lo ven las dos personas.
 *  A las sesiones interactivas no se les dice nada mas: es lo que pidio Edu. */
async function avisarDondeSeAtiende(t: T.Thread, sess: SessionRecord | null, cwd: string) {
  const p = puente(t);
  if (!sess || !p || !tieneHilo(t)) return;
  const como = apartes.get(t.id)?.modo === "ventana" ? "en una ventana nueva" : "en segundo plano";
  const copia = (T.load(t.id) ?? t).copiaDe ? ", sobre una copia limpia" : "";
  const nueva = await avisoNueva();
  await p.aviso(t, `:desktop_computer: ${Cfg.load().human ?? "aqui"} lo atiende un Claude aparte ${como}, en \`${basename(cwd)}\`${copia}.${nueva ? ` (${nueva})` : ""}`);
}

const sessById = (id: string) => liveSessions().find(s => s.sessionId === id);

/** Entrega a un lado: por socket si esta en esta maquina, por Slack si no. */
async function sendToSide(t: T.Thread, side: T.Side, text: string, m?: T.Msg): Promise<boolean> {
  const local = sessById(side.sessionId);
  if (local) return send(local, conTranscript(t, side.sessionId, text));
  const p = puente(t);
  if (p && tieneHilo(t)) return p.post(t, text, m);
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
      if (!me) return { ok: false, error: "esta sesion no esta registrada; reinicia Claude Code con el hook puesto" };
      const cfg = Cfg.load();
      const now = Date.now();

      // Destino remoto: "@sam" va por Slack. Destino local: por nombre de sesion.
      const remote = typeof req.to === "string" && req.to.startsWith("@");
      let to: T.Side;
      let porNostr: { pk: string; relays: string[] } | null = null;
      if (remote) {
        if (!slack && !nostr) return { ok: false, error: "ni Slack ni Nostr estan configurados: corre `spoochie join <invitacion>` o `spoochie slack setup`" };
        // Primero la agenda local: quien te invito o a quien invitaste. Slack solo
        // si no esta, porque buscar por nombre alli exige un scope que puede faltar.
        const u = Cfg.contact(cfg, req.to.slice(1)) ?? (slack ? await slack.lookupUser(req.to.slice(1)) : null);
        if (!u) return { ok: false, error: `no encuentro a ${req.to}: ni en tu agenda de spoochie${slack ? " ni en Slack" : ""}` };
        // Con clave Nostr de los dos lados, va por Nostr (cifrado, sin servidor); Slack
        // se queda para avisar. Con --transporte slack, o sin clave, va por Slack.
        const npubOtro = (u as any).npub as string | undefined;
        if (nostr && npubOtro && cfg.transporte !== "slack") {
          porNostr = { pk: npubOtro, relays: (u as any).relays ?? RELAYS_POR_DEFECTO };
          to = { sessionId: `nostr:${npubOtro}`, name: u.name, cwd: "(otra maquina)", human: u.name, slackUser: u.id.startsWith("nostr:") ? undefined : u.id };
        } else {
          if (!slack) return { ok: false, error: `${req.to} no tiene clave Nostr en tu agenda y aqui no hay Slack: pidele que se de de alta con tu invitacion` };
          to = { sessionId: `slack:${u.id}`, name: u.name, cwd: "(otra maquina)", human: u.name, slackUser: u.id };
        }
      } else {
        const matches = findSession(req.to).filter(s => s.sessionId !== req.sessionId);
        if (matches.length === 0) return { ok: false, error: `no encuentro ninguna sesion viva que encaje con "${req.to}"` };
        if (matches.length > 1) return { ok: false, error: `"${req.to}" encaja con varias`, candidates: matches.map(s => `${s.name} (${s.cwd})`) };
        const m = matches[0];
        to = { sessionId: m.sessionId, name: m.name, cwd: m.cwd };
      }

      const t: T.Thread = {
        id: T.newId(),
        subject: req.subject,
        from: { sessionId: me.sessionId, name: me.name, cwd: me.cwd, human: cfg.human, slackUser: cfg.slack?.userId },
        to,
        state: "pending",
        createdAt: now,
        lastActivityAt: now,
        context: req.context ?? {},
        messages: [{ at: now, from: me.sessionId, author: req.author ?? "claude", kind: req.kind ?? "text", text: req.body, files: req.files }],
      };

      if (remote && porNostr && nostr) {
        const ok = await nostr.openThread(t, porNostr.pk, porNostr.relays);
        if (!ok) return { ok: false, error: "no pude publicar la invitacion en ningun rele de Nostr" };
        // Slack avisa a la persona, si la conocemos por Slack: el hilo no vive ahi.
        if (slack && to.slackUser) void slack.avisarDm(to.slackUser, `${cfg.human ?? me.name} te ha abierto un spoochie por Nostr: "${t.subject}". Te salta el aviso en tu Mac; la conversacion va cifrada y no pasa por Slack.`);
      } else if (remote && slack) {
        const th = await slack.openThread(t);
        if (!th) return { ok: false, error: "no pude abrir el hilo en Slack" };
        t.slack = th;
        t.transporte = "slack";
      }
      T.save(t);
      await refreshTranscript(t);

      // Quien abre es quien publica el transcript: el Artifact es suyo.
      if (Cfg.load().transcript) { t.transcriptOwner = me.sessionId; T.save(t); }
      const delivered = remote ? true : await sendToSide(t, t.to, T.renderInvite(t, t.to.sessionId));
      log("open", t.id, me.name, "->", to.name, delivered ? "entregado" : "FALLO");
      return { ok: true, id: t.id, to: to.name, delivered, transcript: t.transcriptUrl };
    }

    /** La puerta de Q3. La abre el humano receptor, no su Claude.
     *  Lo que la hace real es el propio sistema de permisos de Claude Code:
     *  `spoochie accept` no debe estar en la allowlist, asi que ejecutarlo saca
     *  el dialogo de permiso y quien lo aprueba es la persona. */
    case "accept": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} no existe` };
      if (t.state === "closed") return { ok: false, error: `spoochie ${req.id} esta cerrado (${t.closeReason})` };
      if (t.state === "open") return { ok: true, id: t.id, already: true };
      if (t.to.sessionId !== req.sessionId) return { ok: false, error: "solo el lado que recibe la invitacion puede aceptarla" };
      t.state = "open";
      t.acceptedAt = Date.now();
      t.acceptedBy = req.by ?? "humano receptor";
      t.lastActivityAt = t.acceptedAt;
      T.save(t);
      await sendToSide(t, t.from, T.renderAccepted(t, t.from.sessionId));
      // Por defecto la conversacion no entra en la sesion que acepto: la atiende un
      // Claude aparte en su mismo directorio. --aqui la deja donde esta.
      const yo = sessById(req.sessionId);
      let aparte: string | undefined;
      if (Cfg.load().aparte !== false && !req.aqui && yo && !yo.aparte && !t.from.sessionId.startsWith(yo.sessionId)) {
        // No se espera a que arranque. A esta sesion no le llega nada mas: la respuesta
        // a este comando es lo ultimo que ve del spoochie.
        aparte = yo.cwd;
        void atender(t, yo.cwd).then(s => avisarDondeSeAtiende(t, s, yo.cwd));
      }
      await refreshTranscript(t);
      log("accept", t.id, "por", t.acceptedBy, aparte ? `aparte en ${aparte}` : "aqui");
      return { ok: true, id: t.id, state: t.state, aparte, ventana: aparte ? Ap.modo() === "ventana" : undefined };
    }

    case "say": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} no existe` };
      if (t.state === "closed") return { ok: false, error: `spoochie ${req.id} esta cerrado (${t.closeReason})` };
      if (!T.isParty(t, req.sessionId)) return { ok: false, error: `esta sesion no es parte del spoochie ${req.id}` };
      if (t.state === "pending") {
        return t.to.sessionId === req.sessionId
          ? { ok: false, error: `el tunel no esta abierto. Preguntale a tu humano y, si acepta, ejecuta: spoochie accept ${t.id}` }
          : { ok: false, error: `el otro lado todavia no ha aceptado el tunel` };
      }

      if (!String(req.text ?? "").trim()) return { ok: false, error: "un mensaje vacio no se manda" };
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
      // "entregado" tiene que ser un hecho comprobado, no la intencion de enviar.
      // Cuando sale por Slack el envio va con retraso, asi que se dice "encolado":
      // decir "entregado" antes de que salga es exactamente la mentira que hace que
      // nadie se fie de un canal.
      let delivered: boolean | "encolado" | "publicado" | "retenido";
      if (sessById(other.sessionId)) {
        // El otro lado esta en esta maquina: aqui se es receptor, y el vigilante
        // mira antes de que entre en su sesion.
        delivered = await vigilar(t, m) ? await sendToSide(t, other, T.renderMessage(t, m, other.sessionId), m) : "retenido";
      } else {
        // Sale por Slack con un pequeno retraso (la cola une mensajes seguidos). Se espera
        // a que salga de verdad, hasta 8 s, para poder decir "publicado" y no "encolado":
        // en la primera prueba real el Claude emisor leyo "encolado" como "atascado" y
        // cerro el tunel dando por perdidos mensajes que habian salido en 3 s.
        let avisarSalida: (ok: boolean) => void = () => {};
        const salida = new Promise<boolean>(r => { avisarSalida = r; });
        encolar(t, m, async (tt, mm) => {
          const otro = T.otherSide(tt, req.sessionId);
          const ok = await sendToSide(tt, otro, T.renderMessage(tt, mm, otro.sessionId), mm);
          log("salida", tt.id, ok ? "publicado en Slack" : "FALLO al publicar");
          avisarSalida(ok);
          if (ok) await puente(tt)?.pensandoOn(tt, otro.human ?? otro.name);
          if (!ok) {
            const yo = sessById(T.mySide(tt, req.sessionId).sessionId);
            if (yo) await send(yo, `[spoochie ${tt.id}] tu mensaje NO salio a Slack. No des por hecho que lo ha leido.`);
          }
        });
        const salio = await Promise.race([salida, new Promise<null>(r => setTimeout(() => r(null), 8_000))]);
        delivered = salio === true ? "publicado" : salio === false ? false : "encolado";
      }
      await refreshTranscript(t);
      log("say", t.id, req.sessionId, m.kind, m.offTopic?.verdict ?? "-", delivered ? "entregado" : "FALLO");
      return { ok: true, id: t.id, state: t.state, delivered, offTopic: m.offTopic, transcript: t.transcriptUrl };
    }

    case "close": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} no existe` };
      if (t.state === "closed") return { ok: true, id: t.id, already: true };
      if (req.sessionId && !T.isParty(t, req.sessionId)) return { ok: false, error: `esta sesion no es parte del spoochie ${req.id}` };
      await closeThread(t, req.reason ?? "cerrado a mano", req.sessionId);
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
        hits: T.buscar(req.q).map(h => ({
          id: h.t.id, subject: h.t.subject, state: h.t.state, donde: h.donde,
          con: (h.t.from.human ?? h.t.from.name) + " y " + (h.t.to.human ?? h.t.to.name),
          cuando: new Date(h.t.createdAt).toISOString().slice(0, 16).replace("T", " "),
          rama: h.t.context.branch,
          extracto: h.msg ? T.contexto(h.msg.text, req.q) : undefined,
          transcript: h.t.transcriptUrl,
        })),
      };
    }

    case "get": {
      const t = T.load(req.id);
      return t ? { ok: true, thread: t } : { ok: false, error: `spoochie ${req.id} no existe` };
    }

    /** El hook SessionEnd: cerrar la pantalla cierra tus spoochies vivos. */
    case "session-end": {
      const closed: string[] = [];
      const porque = String(req.sessionId).startsWith("aparte-") ? "se cerro la ventana del Claude aparte" : "la otra sesion se cerro";
      for (const t of T.activeFor(req.sessionId)) {
        await closeThread(t, porque, req.sessionId);
        closed.push(t.id);
      }
      return { ok: true, closed };
    }

    /** Q7: si el spoochie llego mientras no habia sesion viva, se entrega en cuanto
     *  arranca una que encaje. La cola aguanta lo que el reloj de 4h.
     *  Encajar no es "ser la primera que arranque": la rama del sobre tiene que
     *  existir en su checkout. Si no, se queda en cola para otra sesion. */
    case "claim": {
      const me = sessById(req.sessionId);
      if (!me) return { ok: false, error: "sesion no registrada" };
      const claimed: string[] = [];
      for (const t of T.all()) {
        if (await assign(t) === me.sessionId) claimed.push(t.id);
      }
      return { ok: true, claimed };
    }

    /** Cuando hay varias sesiones abiertas, la persona dice cual se lo queda. */
    case "take": {
      const me = sessById(req.sessionId);
      if (!me) return { ok: false, error: "sesion no registrada" };
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} no existe` };
      if (t.state === "closed") return { ok: false, error: `spoochie ${req.id} esta cerrado` };
      const actual = t.state === "open" && !T.esRemoto(t.to.sessionId) ? sessById(t.to.sessionId) : undefined;
      // Un aparte si se puede mover de repo con take; otra sesion interactiva viva, no.
      if (actual && !actual.aparte) return { ok: false, error: `spoochie ${req.id} ya lo atiende ${t.to.name}` };
      // Tomarlo desde una sesion fija el directorio. Si ya esta aceptado y toca Claude
      // aparte, se lanza ahi (o se deja el que ya hay si es el mismo repo); si no, la
      // invitacion entra en la sesion para que el humano acepte, y el aparte nace al aceptar.
      if (t.state === "open" && Cfg.load().aparte !== false && !req.aqui) {
        const apActual = apartes.get(t.id);
        const mismo = (apActual?.origen ?? apActual?.cwd) === me.cwd && actual?.aparte;
        void atender(t, me.cwd).then(s => { if (!mismo) return avisarDondeSeAtiende(t, s, me.cwd); });
        log("take", t.id, "->", me.name, mismo ? "ya estaba en" : "aparte en", me.cwd);
        return { ok: true, id: t.id, aparte: me.cwd, already: Boolean(mismo), ventana: Ap.modo() === "ventana" };
      }
      if (actual?.aparte) {
        // --aqui sobre un spoochie que atendia un aparte: el aparte se despide.
        const ap = apartes.get(t.id) ?? { id: t.id, cwd: actual.cwd, modo: "ventana" as const, sess: actual, cola: [], listo: true, muerto: false };
        apartes.delete(t.id);
        await despedir(ap, `lo atiende ahora la sesion ${me.name}`);
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
      if (!t) return { ok: false, error: `spoochie ${req.id} no existe` };
      const mio = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
      if (req.sessionId && req.sessionId !== mio) return { ok: false, error: "solo el lado que recibe puede soltar lo retenido" };
      const n = await soltar(t, req.op === "release" ? "suelta" : "descarta", "por CLI");
      return { ok: true, id: t.id, [req.op === "release" ? "released" : "discarded"]: n };
    }

    case "transcript-url": {
      const t = T.load(req.id);
      if (!t) return { ok: false, error: `spoochie ${req.id} no existe` };
      t.transcriptUrl = req.url;
      t.transcriptOwner = req.sessionId ?? t.transcriptOwner;
      t.transcriptStale = 0;
      T.save(t);
      if (tieneHilo(t)) await puente(t)?.post(t, `Transcript en vivo: ${req.url}`);
      return { ok: true, id: t.id, url: req.url };
    }

    case "slack-reload": {
      slack = SlackBridge.fromConfig(onSlackMessage, onSlackAccept, onRemoteAccept, (t, o) => soltar(t, o, "desde Slack").then(() => {}), onRemoteClose);
      arrancarNostr();
      return { ok: true, slack: Boolean(slack), nostr: Boolean(nostr) };
    }

    default:
      return { ok: false, error: `op desconocida: ${req.op}` };
  }
}

/**
 * A que sesion local le toca un spoochie que llega de fuera.
 *
 * Siempre a UNA, y con la invitacion entera. La version anterior, con varias sesiones
 * y sin rama que encajara, mandaba a todas una linea de "hay varias, haz take" sin el
 * mensaje: en la primera prueba real la pregunta no llego a ninguna terminal, y el Claude de
 * la terminal equivocada hizo take por su cuenta. Orden: la rama del sobre existe en
 * el checkout; el asunto o el primer mensaje nombran el directorio; y si no, la
 * sesion donde la persona escribio por ultima vez.
 */
function elegir(t: T.Thread): { pick: SessionRecord | null; otras: number } {
  // Un Claude aparte atiende un solo spoochie: nunca es candidato para otro.
  const vivas = liveSessions().filter(s => !s.aparte);
  if (vivas.length === 0) return { pick: null, otras: 0 };
  const otras = vivas.length - 1;
  const porRama = vivas.filter(s => repoMatches(s.cwd, t.context.branch));
  if (porRama.length) return { pick: porRama[0], otras };
  const texto = `${t.subject}\n${t.messages[0]?.text ?? ""}`.toLowerCase();
  const porNombre = vivas.filter(s => { const b = basename(s.cwd).toLowerCase(); return b.length >= 3 && texto.includes(b); });
  if (porNombre.length) return { pick: porNombre[0], otras };
  return { pick: vivas[0], otras };
}

/** Los dialogos de aviso abiertos, por spoochie: uno por spoochie, y se cierran solos
 *  si el tunel se acepta desde Slack o se cierra. */
const dialogos = new Map<string, import("node:child_process").ChildProcess>();

/** Asigna el spoochie a la sesion que le toca y avisa a la persona. En macOS el aviso
 *  es un dialogo del sistema y la sesion no ve nada: solo presta su directorio para el
 *  Claude aparte. Sin escritorio, la invitacion entra en esa sesion como antes. */
async function assign(t: T.Thread): Promise<string | null> {
  if (t.state !== "pending" || !T.esRemoto(t.to.sessionId)) return null;
  // Quien abrio el tunel no es el destinatario: si se lo repartiera a si mismo,
  // se pisaria el nombre del otro lado y el transcript diria "Sam y Sam".
  const yo = Cfg.load().slack?.userId;
  if (yo && t.from.slackUser === yo) return null;
  const { pick, otras } = elegir(t);
  if (!pick) return null;
  t.to = { ...t.to, sessionId: pick.sessionId, name: pick.name, cwd: pick.cwd, human: Cfg.load().human ?? t.to.human };
  T.save(t);
  if (Dlg.modoAviso() === "dialogo") {
    if (!dialogos.has(t.id)) avisarConDialogo(t, pick);
    log("assign", t.id, "-> dialogo, repo de", pick.name);
    return pick.sessionId;
  }
  const extra = otras ? `\nSi esto es para otra sesion tuya (hay ${otras} mas abiertas), tu humano lo dice y desde alli:  spoochie take ${t.id}` : "";
  await send(pick, T.renderInvite(t, pick.sessionId) + extra);
  log("assign", t.id, "->", pick.name, otras ? `(${otras} sesiones mas)` : "");
  return pick.sessionId;
}

function avisarConDialogo(t: T.Thread, pick: SessionRecord) {
  const { child, respuesta } = Dlg.preguntar(t);
  dialogos.set(t.id, child);
  void respuesta.then(async r => {
    if (dialogos.get(t.id) === child) dialogos.delete(t.id);
    const fresco = T.load(t.id);
    log("aviso", t.id, "dialogo:", r ?? "sin respuesta");
    // Mientras el dialogo estaba abierto pudo aceptarse en Slack o caducar: manda el estado.
    if (!fresco || fresco.state !== "pending") return;
    if (r === "acepto") await onSlackAccept(fresco, "en el aviso");
    else if (r === "rechazo") await closeThread(fresco, `rechazado por ${Cfg.load().human ?? "la persona"}`, pick.sessionId);
    else if (r === "slack" && fresco.slack) Dlg.abrirEnSlack(slack ? await slack.teamId() : null, fresco.slack.channel, fresco.slack.ts);
  });
}

function cerrarDialogo(id: string) {
  const d = dialogos.get(id);
  if (d) { dialogos.delete(id); try { d.kill(); } catch {} }
}

/** Aceptar escribiendo en el hilo de Slack. Hace lo mismo que `spoochie accept`. */
async function onSlackAccept(t: T.Thread, quien: string) {
  // El puente puede traer un hilo viejo: "acepto" y luego "continua" en el mismo
  // tick publicaban dos veces "ha aceptado". Se mira el estado fresco.
  if ((T.load(t.id) ?? t).state !== "pending") return;
  // Puede que el spoochie todavia no tenga sesion local: primero se le busca una.
  if (T.esRemoto(t.to.sessionId)) await assign(t);
  const fresco = T.load(t.id) ?? t;
  fresco.state = "open";
  fresco.acceptedAt = Date.now();
  fresco.acceptedBy = Cfg.load().human ?? quien;
  fresco.lastActivityAt = fresco.acceptedAt;
  T.save(fresco);
  cerrarDialogo(fresco.id);
  await sendToSide(fresco, fresco.from, T.renderAccepted(fresco, fresco.from.sessionId));
  const local = sessById(fresco.to.sessionId);
  if (local && !local.aparte) {
    if (Cfg.load().aparte !== false && !fresco.from.sessionId.startsWith(local.sessionId)) {
      // Con el aviso en dialogo, la sesion nunca supo del spoochie y no hay nada que
      // decirle. Con la invitacion en la terminal si: una linea, y es la ultima que ve;
      // sin ella su Claude se queda con "¿lo aceptas?" en el aire y hace accept o take.
      if (Dlg.modoAviso() !== "dialogo") await send(local, `[spoochie ${fresco.id} | ${fresco.subject}] tu humano lo acepto ${quien}. Lo atiende un Claude aparte en una ventana nueva; a esta sesion no le llega nada mas. No hagas accept ni take.`);
      void atender(fresco, local.cwd).then(s => avisarDondeSeAtiende(fresco, s, local.cwd));
    } else {
      await send(local, `[spoochie ${fresco.id} | ${fresco.subject}] tu humano lo ha aceptado ${quien}. El tunel esta abierto: puedes contestar con  spoochie say ${fresco.id} "<texto>"`);
    }
  } else if (!local) {
    // Ninguna sesion de Claude Code abierta en esta maquina: no hay repo donde nacer.
    if (puente(fresco) && tieneHilo(fresco)) await puente(fresco)!.aviso(fresco, `:warning: ${Cfg.load().human ?? "el otro lado"} no tiene ninguna sesion de Claude Code abierta. El spoochie espera: al abrir una en el repo, \`spoochie take ${fresco.id}\`.`);
  }
  await refreshTranscript(fresco);
  log("accept", fresco.id, quien, local ? `-> ${local.name}` : "sin sesion local");
}

/** El otro lado ha aceptado: quien abrio el tunel se entera y sale de "pending". */
async function onRemoteAccept(t: T.Thread, quien: string) {
  const fresco = T.load(t.id) ?? t;
  if (fresco.state !== "pending") return;
  fresco.state = "open";
  fresco.acceptedAt = Date.now();
  fresco.acceptedBy = fresco.to.human ?? quien;
  fresco.lastActivityAt = fresco.acceptedAt;
  T.save(fresco);
  const local = sessById(fresco.from.sessionId);
  if (local) await send(local, T.renderAccepted(fresco, fresco.from.sessionId));
  await refreshTranscript(fresco);
  log("remote-accept", fresco.id);
}

/** Un turno que llega por Slack desde otra maquina, o de un humano escribiendo en el hilo. */
async function onSlackMessage(t: T.Thread, m: T.Msg) {
  // Cerrado es cerrado: lo que llegue tarde (un rele lento, alguien escribiendo en el
  // hilo de Slack ya cerrado) no vuelve a llenar un spoochie que ya se purgo.
  if (t.state === "closed") { log("entrada", t.id, "mensaje tras cerrar; descartado"); return; }
  t.messages.push(m);
  t.lastActivityAt = m.at;
  if (t.state === "pending" && m.author === "human") { t.state = "open"; t.acceptedAt = m.at; t.acceptedBy = "humano en Slack"; }
  T.save(t);
  // Un spoochie recien descubierto todavia no tiene lado local: se le busca uno.
  if (t.state === "pending" && T.esRemoto(t.to.sessionId)) {
    const asignada = await assign(t);
    log("slack-in", t.id, m.author, asignada ? "asignado" : "sin sesion a la que asignar");
    return;
  }
  const mio = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
  const local = sessById(mio);
  if (local && !(await vigilar(t, m))) {
    log("slack-in", t.id, m.author, "RETENIDO", m.peligro);
    await refreshTranscript(t);
    return;
  }
  if (local) {
    await send(local, conTranscript(t, mio, T.renderMessage(t, m, mio)));
    // El otro lado ve que aqui se esta trabajando, en vez de 40 segundos en blanco.
    await puente(t)?.pensandoOn(t, T.mySide(t, mio).human ?? T.mySide(t, mio).name);
  }
  await refreshTranscript(t);
  log("slack-in", t.id, m.author, local ? "entregado" : "sin sesion local");
}

/** El vigilante, en el lado que recibe. Devuelve si el mensaje puede entrar.
 *  Un mensaje que pide actuar se queda en el hilo, marcado, hasta que el humano
 *  receptor lo suelte; uno fuera de tema entra con su etiqueta y un aviso en Slack. */
async function vigilar(t: T.Thread, m: T.Msg): Promise<boolean> {
  if (!Cfg.load().guardian || m.kind !== "text" || m.author === "spoochie") return true;
  const v = await judge(t.subject, m.text);
  m.offTopic = { verdict: v.verdict, why: v.why };
  const quien = T.otherSide(t, T.mySide(t, sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId).sessionId);
  if (v.peligro) {
    m.retenido = "si";
    m.peligro = v.why;
    T.save(t);
    const receptor = T.mySide(t, sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId);
    if (puente(t) && tieneHilo(t)) await puente(t)!.aviso(t, `:no_entry: *retenido por el vigilante*: ${v.why}. <@${receptor.slackUser ?? ""}> escribe \`suelta\` en este hilo para entregarlo, o \`descarta\`.`);
    const local = sessById(receptor.sessionId);
    if (local) await send(local, `[spoochie ${t.id} | ${t.subject}] un mensaje de ${quien.human ?? quien.name} esta RETENIDO por el vigilante: ${v.why}. No lo has recibido. Tu humano decide: "suelta" o "descarta" en el hilo de Slack, o  spoochie release ${t.id}  /  spoochie discard ${t.id}`);
    return false;
  }
  if (v.verdict !== "dentro") {
    T.save(t);
    if (puente(t) && tieneHilo(t)) await puente(t)!.aviso(t, v.verdict === "sin vigilar" ? `:grey_question: ${v.why}.` : `:warning: el vigilante lo ve *${v.verdict}* del asunto: ${v.why}`);
  }
  return true;
}

/** Lo que el humano receptor decide sobre lo retenido. */
async function soltar(t: T.Thread, orden: "suelta" | "descarta", como: string): Promise<number> {
  const mio = sessById(t.to.sessionId) ? t.to.sessionId : t.from.sessionId;
  const local = sessById(mio);
  let n = 0;
  for (const m of t.messages) {
    if (m.retenido !== "si") continue;
    m.retenido = orden === "suelta" ? "suelto" : "descartado";
    n++;
    if (orden === "suelta" && local) await send(local, conTranscript(t, mio, T.renderMessage(t, m, mio)));
  }
  if (n) {
    t.lastActivityAt = Date.now();
    T.save(t);
    if (puente(t) && tieneHilo(t)) await puente(t)!.aviso(t, orden === "suelta" ? `:unlock: ${n} mensaje(s) retenido(s) entregado(s) ${como}.` : `:wastebasket: ${n} mensaje(s) retenido(s) descartado(s) ${como}.`);
    await refreshTranscript(t);
  }
  log("retenidos", t.id, orden, n, como);
  return n;
}

/** A quien esta en la agenda por Slack pero sin clave Nostr, se le manda la mia por su
 *  DM. Su demonio la guarda y contesta con la suya; en una vuelta los dos la tienen y
 *  el siguiente spoochie va cifrado. Una vez por contacto y arranque. */
const holasMandados = new Set<string>();
async function repartirClaveNostr() {
  if (!slack || !nostr) return;
  const c = Cfg.load();
  for (const k of Object.values(c.contacts ?? {})) {
    if (k.npub || !/^[UW][A-Z0-9]{6,}$/.test(k.id) || holasMandados.has(k.id)) continue;
    holasMandados.add(k.id);
    const ok = await slack.hola(k.id, nostr.pk, nostr.relays, c.human ?? "alguien");
    log("nostr", "clave mandada por Slack a", k.name, ok ? "ok" : "FALLO");
  }
}

function arrancarNostr() {
  nostr?.cerrar();
  nostr = NostrBridge.fromConfig({
    onMessage: onSlackMessage, onRemoteAccept, onCierre: onRemoteClose, log,
    onHola: async (de, sobre, nombre) => {
      // Alguien a quien invite ya esta dentro: su clave entra en la agenda, pegada a su
      // id de Slack si lo dijo (asi el aviso por DM sigue funcionando).
      const c = Cfg.load();
      const previo = (sobre.slack && Cfg.contactById(c, sobre.slack)) || Cfg.contactoPorNpub(c, de);
      Cfg.addContact(c, { id: previo?.id ?? sobre.slack ?? `nostr:${de}`, name: previo?.name ?? nombre, npub: de, relays: sobre.relays });
      Cfg.save(c);
      log("nostr", "hola de", nombre, de.slice(0, 12));
    },
  }, process.env.SPOOCHIE_NOSTR_DIR ? poolDeFichero(process.env.SPOOCHIE_NOSTR_DIR) : undefined);
  nostr?.escuchar();
  if (slack) {
    slack.onHola = async (de, nombre, np, r) => {
      const c = Cfg.load();
      const previo = Cfg.contactById(c, de);
      Cfg.addContact(c, { id: de, name: previo?.name ?? nombre, npub: np, relays: r });
      Cfg.save(c);
      log("nostr", "clave recibida por Slack de", previo?.name ?? nombre);
      // Si el no tiene la mia, se la mando (una vez): asi converge en una vuelta.
      if (nostr && !holasMandados.has(de)) { holasMandados.add(de); await slack!.hola(de, nostr.pk, nostr.relays, c.human ?? "alguien"); }
    };
  }
  setTimeout(() => { void repartirClaveNostr(); }, 3000).unref();
}

/** El otro lado cerro: se cierra aqui sin volver a avisarle, y se borra igual. */
async function onRemoteClose(t: T.Thread, motivo: string) {
  const fresco = T.load(t.id) ?? t;
  if (fresco.state === "closed") return;
  await closeThread(fresco, motivo, undefined, true);
}

/** Lo que se borra al cerrar, con el retraso justo para que el otro demonio lea el
 *  cierre antes de que desaparezca del hilo (su sondeo es de 4 s). */
const BORRAR_SLACK_TRAS_MS = 45_000;

async function closeThread(t: T.Thread, reason: string, bySession?: string, remoto = false) {
  cerrarDialogo(t.id);
  t.state = "closed";
  t.closedAt = Date.now();
  t.closeReason = reason;
  T.save(t);
  const notified: string[] = [];
  for (const side of [t.from, t.to]) {
    if (side.sessionId === bySession) continue;
    // Si lo cerro el otro lado, no se le devuelve el aviso: solo se entera este.
    if (remoto && !sessById(side.sessionId)) continue;
    const ok = await sendToSide(t, side, T.renderClose(t));
    notified.push(`${side.name}:${ok ? "entregado" : "FALLO"}`);
  }
  await refreshTranscript(t);
  log("close", t.id, reason, notified.join(" "));
  if (Cfg.load().borrarAlCerrar !== false) {
    // En local, ya: la conversacion vive en el Claude que la tuvo, no aqui.
    T.purgar(t, { spool: join(SPOOL, t.id), transcript: rutaTranscript(t.id) });
    log("borrado", t.id, "local");
    const p = puente(t);
    if (p && tieneHilo(t)) {
      setTimeout(async () => { const n = await p.borrarHilo(t); log("borrado", t.id, t.transporte ?? "slack", n, "envios"); }, BORRAR_SLACK_TRAS_MS).unref();
    }
  }
  const ap = apartes.get(t.id);
  if (t.copiaDe) { const [origen, copia] = [t.copiaDe, t.to.cwd]; setTimeout(() => { Ap.quitarCopia(origen, copia); log("aparte", t.id, "copia retirada"); }, 60_000).unref(); }
  if (ap?.modo === "fondo") setTimeout(() => Ap.matar(ap), 15_000).unref();
  if (ap?.modo === "ventana" && ap.listo) { const r = sessById(ap.sess.sessionId); if (r) await send(r, `Este spoochie ha terminado. Puedes cerrar esta ventana.`); }
  if (ap) apartes.delete(t.id);
}

async function tick() {
  const now = Date.now();
  for (const t of T.all()) {
    if (t.state === "closed") continue;
    const due = T.expiresAt(t);
    if (due === null) continue;
    if (now > due) {
      await closeThread(t, t.state === "pending" ? "caducado sin aceptar (4h)" : "silencio de 10 min");
      continue;
    }
    // Avisar antes de matarlo, en vez de que desaparezca sin decir nada.
    if (t.state === "open" && !t.avisado && due - now < T.AVISO_ANTES_MS) {
      t.avisado = true;
      T.save(t);
      for (const side of [t.from, t.to]) {
        const s = sessById(side.sessionId);
        if (s) await send(s, T.renderAviso(t, (due - now) / 1000, side.sessionId));
      }
      log("aviso-silencio", t.id);
    }
  }
  if (slack) { try { await slack.poll(); } catch (e) { log("slack-poll-error", String(e)); } }
}

function main() {
  ensureDirs();
  if (alreadyRunning()) { console.error("spoochied ya esta corriendo"); process.exit(0); }
  if (existsSync(DAEMON_SOCK)) unlinkSync(DAEMON_SOCK);
  writeFileSync(DAEMON_LOCK, String(process.pid));
  // El latido es lo unico que distingue un demonio vivo de uno colgado.
  latir();
  setInterval(latir, LATIDO_MS).unref();
  slack = SlackBridge.fromConfig(onSlackMessage, onSlackAccept, onRemoteAccept, (t, o) => soltar(t, o, "desde Slack").then(() => {}), onRemoteClose);
  arrancarNostr();
  // Lo que un demonio anterior dejo sin sacar, y las ventanas de aparte que siguen vivas.
  const reanudados = reanudar(async (tt, mm) => {
    const yo = sessById(tt.from.sessionId) ? tt.from : tt.to;
    const otro = T.otherSide(tt, yo.sessionId);
    const ok = await sendToSide(tt, otro, T.renderMessage(tt, mm, otro.sessionId), mm);
    log("salida", tt.id, ok ? "publicado en Slack (reanudado)" : "FALLO al publicar (se reintenta)");
    return ok;
  });
  if (reanudados) log("cola", "reanudados", reanudados);
  for (const s of liveSessions()) {
    if (!s.aparte || s.socket === Ap.SOCKET_PENDIENTE || s.socket === "(stdin)") continue;
    const th = T.load(s.aparte);
    apartes.set(s.aparte, { id: s.aparte, cwd: s.cwd, modo: "ventana", sess: s, cola: [], listo: true, muerto: false, origen: th?.copiaDe });
    log("aparte", s.aparte, "reenganchado, ventana pid", s.pid);
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

  server.listen(DAEMON_SOCK, () => log("spoochied", VERSION, "escuchando", DAEMON_SOCK, "pid", process.pid, "slack", Boolean(slack)));

  const late = () => {
    const vivo = T.all().some(t => t.state !== "closed" && tieneHilo(t));
    tick()
      .catch(e => log("tick-error", String(e)))
      .finally(() => setTimeout(late, vivo ? TICK_VIVO_MS : TICK_IDLE_MS));
  };
  setTimeout(late, TICK_VIVO_MS);

  const bye = () => { try { unlinkSync(DAEMON_SOCK); } catch {} try { unlinkSync(DAEMON_LOCK); } catch {} process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}

main();
