/**
 * A pass over everything that has to be right for a spoochie to arrive.
 *
 * It exists because this tool's failures are silent by nature: an expired
 * token, a file with loose permissions or a dead daemon don't raise an error, they just
 * make the message not arrive and nobody notice.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SESSIONS_DIR, THREADS_DIR, DAEMON_SOCK, DAEMON_LOCK, OUTBOX_FILE } from "./paths.ts";
import { liveSessions, loosePermissions } from "./registry.ts";
import * as Cfg from "./config.ts";
import * as T from "./threads.ts";
import * as Des from "./strangers.ts";
import { whoIs } from "./slack.ts";

export type Check = { ok: boolean | "aviso"; que: string; detalle: string };

const mode = (p: string) => { try { return (statSync(p).mode & 0o777).toString(8).padStart(3, "0"); } catch { return "?"; } };

export async function check(): Promise<Check[]> {
  const out: Check[] = [];
  const c = Cfg.load();

  out.push({
    ok: existsSync(DAEMON_SOCK) && existsSync(DAEMON_LOCK),
    que: "daemon",
    detalle: existsSync(DAEMON_LOCK) ? `alive, pid ${(await Bun.file(DAEMON_LOCK).text()).trim()}` : "not running",
  });
  {
    const { heartbeatAge, launchdInstalled } = await import("./startup.ts");
    const age = heartbeatAge();
    out.push({
      ok: age !== null && age < 90,
      que: "daemon heartbeat",
      detalle: age === null ? "has never beaten" : age < 90 ? `${Math.round(age)} s ago${launchdInstalled() ? ", under launchd" : ", started by a hook (dies on restart)"}` : `${Math.round(age)} s ago: it's hung or dead`,
    });
  }

  const dirMode = mode(ROOT);
  out.push({
    ok: dirMode === "700",
    que: "directory permissions",
    detalle: `${ROOT} is ${dirMode}${dirMode === "700" ? "" : ", should be 700"}`,
  });

  const loose = existsSync(SESSIONS_DIR)
    ? readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json") && loosePermissions(join(SESSIONS_DIR, f)))
    : [];
  out.push({
    ok: loose.length === 0,
    que: "inbox tokens at rest",
    detalle: loose.length
      ? `${loose.length} with open permissions: ${loose.join(", ")}. chmod 600.`
      : "each registered session keeps its token at 0600, for you only",
  });

  const live = liveSessions();
  out.push({ ok: live.length > 0, que: "registered sessions", detalle: live.length ? live.map(s => s.name).join(", ") : "none: the SessionStart hook is missing, or the session needs a restart" });

  const brokenSockets = live.filter(s => !existsSync(s.socket));
  if (brokenSockets.length) out.push({ ok: false, que: "inboxes", detalle: `${brokenSockets.length} sessions without a socket` });

  if (!c.slack) {
    out.push({ ok: "aviso", que: "Slack", detalle: "not set up: spoochie only works on this machine" });
  } else {
    const user = Cfg.slackToken(c), bot = Cfg.slackBotToken(c);
    const me = user ? await whoIs(user) : null;
    const theBot = bot ? await whoIs(bot) : null;
    // The user token is optional since the bot can look people up: it only
    // complains if it's set and doesn't work, not if it's missing.
    if (user) out.push({ ok: Boolean(me), que: "user token", detalle: me ? `${me.user} in ${me.team}` : "is set and doesn't work" });
    out.push({ ok: Boolean(theBot), que: "bot token", detalle: theBot ? `${theBot.user}` : "doesn't work or is missing" });
    if (theBot && !user) {
      // Without a user token, looking people up depends on the app having bot
      // users:read. If it doesn't, opening a spoochie by name or email fails in the only
      // place where it hurts: when writing to someone for the first time.
      const r = await fetch("https://slack.com/api/users.list?limit=1", { headers: { authorization: `Bearer ${bot}` } }).then(x => x.json()).catch(() => ({ ok: false }));
      out.push({
        ok: r.ok === true, que: "people lookup",
        detalle: r.ok ? "the bot can, no user token needed"
                      : "the app needs users:read and users:read.email as BOT scopes",
      });
    }
    if (c.slack.tokenFile) {
      out.push({
        ok: !loosePermissions(c.slack.tokenFile),
        que: "token file",
        detalle: `${c.slack.tokenFile} is ${mode(c.slack.tokenFile)}`,
      });
    }
  }

  const open = T.all().filter(t => t.state !== "closed");
  out.push({
    ok: true,
    que: "spoochies",
    detalle: `${open.length} live, ${T.all().length} in total on this machine`,
  });

  out.push({
    ok: c.guardian ? "aviso" : true,
    que: "topic watcher",
    detalle: c.guardian
      ? "on: costs one Haiku call per message received, paid by the receiver"
      : "off",
  });

  out.push({
    ok: true,
    que: "transcript",
    detalle: c.transcript ? "on: whoever opened is asked to republish on every turn" : "off",
  });

  {
    const N = await import("./nostr.ts");
    out.push({
      ok: c.nostr?.pk ? true : "aviso",
      que: "Nostr",
      detalle: c.nostr?.pk ? `${N.npub(c.nostr.pk).slice(0, 16)}..., relays: ${N.myRelays(c).join(", ")}${c.transporte === "slack" ? " (threads go over Slack)" : ""}` : "no key yet: it's created by `spoochie nostr`, `invite` or `join`",
    });
    const noKey = Object.values(c.contacts ?? {}).filter(k => !k.npub).map(k => k.name);
    if (noKey.length) out.push({ ok: "aviso", que: "contacts without a Nostr key", detalle: `${noKey.join(", ")}: with them it goes over Slack until their spoochie (>= 0.9) sends its key` });
  }

  out.push({
    ok: true,
    que: "delete on close",
    detalle: c.borrarAlCerrar === false ? "off: conversations stay on disk and in Slack" : "on: closing deletes it locally and what the bot posted in Slack",
  });

  out.push({
    ok: true,
    que: "aside Claude",
    detalle: c.aparte === false ? "off: everything goes into your session" : `on${c.aparteCopia === false ? ", in the real checkout" : ", on a clean copy of the repo"}`,
  });

  {
    const { VERSION } = await import("./version.ts");
    const { newVersionNotice } = await import("./update.ts");
    const update = await newVersionNotice();
    out.push({ ok: update ? "aviso" : true, que: "version", detalle: update ? `${VERSION}; ${update}` : `${VERSION}, the latest published` });
    const { heartbeatVersion, heartbeatAge, installedAgentPath, findClaude } = await import("./startup.ts");
    const c = claudeCheck(installedAgentPath(), findClaude);
    if (c) out.push(c);
    const beat = heartbeatVersion();
    const alive = (heartbeatAge() ?? Infinity) < 90;
    if (alive && beat !== VERSION) out.push({
      ok: "aviso",
      que: "daemon version",
      detalle: `${beat ?? "older than 0.9.1"}, and this spoochie is ${VERSION}: the daemon started before the update. Restart Claude Code and the hook swaps it`,
    });
  }

  if (existsSync(OUTBOX_FILE)) {
    try {
      const n = (JSON.parse(readFileSync(OUTBOX_FILE, "utf8")) as { msgs: unknown[] }[]).reduce((a, d) => a + d.msgs.length, 0);
      if (n) out.push({ ok: "aviso", que: "outbox", detalle: `${n} message(s) waiting to go out to Slack; the daemon retries every minute` });
    } catch {}
  }

  if (existsSync(THREADS_DIR)) {
    const old = T.all().filter(t => t.state === "closed" && Date.now() - (t.closedAt ?? 0) > 30 * 24 * 3600 * 1000);
    if (old.length) out.push({ ok: "aviso", que: "cleanup", detalle: `${old.length} spoochies closed more than a month ago` });
  }

  {
    // What the hook prints goes into THAT session's context and stays there; if
    // it failed and the person restarted, without this there's no way to find out later.
    const p = join(ROOT, "arranque.txt");
    const result = lastStart(existsSync(p) ? readFileSync(p, "utf8") : null);
    if (result) out.push(result);
  }

  // The audit part: not "this is broken", but "this is a credential or a leftover
  // that shouldn't still be here". Security failures don't raise errors either.
  out.push(...audit(c));

  return out;
}

/**
 * The daemon launches the aside Claude by name, with the daemon's PATH. If
 * `claude` isn't there, a spoochie gets accepted and nobody handles it: on 01-10 it was exactly that,
 * and `doctor` said everything was fine, because it checked that the daemon was alive and not
 * that it could do the one thing it lives for.
 */
export function claudeCheck(daemonPath: string | null, find: (dirs: string[]) => string | null): Check | null {
  if (!daemonPath) return null;
  const dir = find(daemonPath.split(":"));
  return dir
    ? { ok: true, que: "claude on the daemon's PATH", detalle: `${dir}/claude` }
    : { ok: false, que: "claude on the daemon's PATH", detalle: `not in ${daemonPath}: an accepted spoochie can't be handled. Open a Claude Code session (the hook fixes it) or run \`spoochie register\`` };
}

/** What the SessionStart hook left written the last time it ran. */
export function lastStart(text: string | null): Check | null {
  if (!text?.trim()) return null;
  // "fallo" is what startup.ts writes to disk: it's a stored value, not text to translate.
  const [when, status, detail] = text.trim().split("\n")[0].split("\t");
  if (status !== "fallo") return { ok: true, que: "last hook start", detalle: `${detail ?? "no detail"} (${when})` };
  return { ok: false, que: "last hook start", detalle: `${detail ?? "failed with no detail"} (${when})` };
}

/**
 * What shouldn't still be on disk. Each point is a hole that existed or that can
 * open on its own just with the passing of time, and none of them raises an error by itself.
 */
export function audit(c: Cfg.Config, now = Date.now()): Check[] {
  const out: Check[] = [];

  // Unredeemed invites: each one is a nonce that still lets a key in.
  const pending = Object.values(c.invitaciones ?? {});
  if (pending.length) {
    const names = pending.map(i => i.name ?? i.id ?? "no name").join(", ");
    out.push({
      ok: "aviso",
      que: "unredeemed invites",
      detalle: `${pending.length} live (${names}): each one lets a key into your contacts until it expires after 30 days`,
    });
  }

  // Whoever tried to talk to me without being in the contacts. Everything but the key
  // is what the envelope says, and it's shown that way. If it claims to be a contact that doesn't have a Nostr
  // key yet, it's almost certainly a join that didn't arrive, and the way out is to link it by hand.
  for (const d of Des.recent(now)) {
    const theirs = d.slack ? Cfg.contactById(c, d.slack) as { id: string; name: string; npub?: string } | null : null;
    const when = new Date(d.ultima).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const what = d.kind === "hola" ? "joined and their key didn't get in" : d.kind === "invite" ? "tried to open a spoochie with you" : `sent you an envelope (${d.kind})`;
    const fix = theirs && !theirs.npub
      ? `if it's ${theirs.name}: spoochie contacts --bind ${theirs.id} --npub ${d.pk}`
      : "if you know them, invite them: spoochie invite --to <their id>";
    out.push({
      ok: "aviso",
      que: "outside your contacts",
      detalle: `${d.nombre ? `claims to be ${d.nombre}` : "no name"}${d.slack ? ` (${d.slack})` : ""}, key ${d.pk.slice(0, 12)}...: ${what}, ${d.veces} time(s), last on ${when}. ${fix}`,
    });
  }

  // Contacts without an ed25519 key: their envelopes can't be checked, so they come in
  // flagged and anyone with the bot token could be the first to sign for them.
  const noKey = Object.values(c.contacts ?? {}).filter(x => !x.pk);
  if (noKey.length) {
    out.push({
      ok: "aviso",
      que: "contacts without a pinned key",
      detalle: `${noKey.map(x => x.name).join(", ")}: until a signed envelope from them arrives, their first signature is the one that gets pinned`,
    });
  }

  // A closed spoochie with text still on disk: delete on close didn't do its job.
  const withText = T.all().filter(t => t.state === "closed" && t.messages.some(m => (m.text ?? "").trim()));
  out.push({
    ok: withText.length === 0,
    que: "delete on close",
    detalle: withText.length
      ? `${withText.length} closed spoochie(s) that still keep the text: ${withText.map(t => t.id).join(", ")}`
      : "no closed spoochie keeps text",
  });

  // Where the secrets live. Having them in the file isn't a failure, but it's worth
  // knowing: any process running as you reads a file without asking permission.
  {
    const inFile = [
      c.keys?.priv && c.keys.priv !== "@llavero" ? "signing key" : null,
      c.nostr?.sk && c.nostr.sk !== "@llavero" ? "Nostr key" : null,
      c.slack?.botToken && c.slack.botToken !== "@llavero" ? "bot token" : null,
    ].filter(Boolean);
    if (inFile.length) out.push({
      ok: "aviso",
      que: "secrets in config.json",
      detalle: `${inFile.join(", ")} in plain text at 0600. On macOS, \`spoochie keychain on\` moves them to the keychain: it goes from "read a file" to "ask the system for permission"`,
    });
  }

  // A whole team on Nostr doesn't need the shared token for anything: not to
  // open, not to notify (the notice is the local dialog), not for the thread. It's worth
  // saying, because it's the only way out of "whoever has the token is in".
  {
    const withKey = Object.values(c.contacts ?? {}).filter(x => x.npub).length;
    const total = Object.values(c.contacts ?? {}).length;
    if (total && withKey === total && c.slack?.botToken) out.push({
      ok: "aviso",
      que: "you no longer need the bot token",
      detalle: `your ${total} contact(s) have a Nostr key: spoochies go encrypted without passing through Slack and the notice is the system dialog. \`spoochie slack off\` removes the token from this machine; you'd only lose the DM notifications`,
    });
  }

  // The bot token in the config is the real edge of the security model. It isn't a
  // failure, but whoever has it has the bot's DM with the whole team, and it has to
  // be rotated when someone leaves.
  if (c.slack?.botToken) {
    out.push({
      ok: "aviso",
      que: "bot token at rest",
      detalle: `this machine keeps the team's bot token in config.json: whoever reads it can read the bot's DM with anyone and post as the bot. Rotate it when someone leaves`,
    });
  }

  return out;
}
