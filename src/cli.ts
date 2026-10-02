#!/usr/bin/env bun
import net from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as rpath } from "node:path";
import { userInfo } from "node:os";
import { DAEMON_SOCK, DAEMON_LOG, ensureDirs, envVar } from "./paths.ts";
import { register, liveSessions, unregister, type SessionRecord } from "./registry.ts";
import * as Cfg from "./config.ts";
import { MAX_MESSAGE, MAX_PATCH, transcriptUrlOf } from "./threads.ts";
import { TRANSCRIPTS_DIR } from "./transcript.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * What the opener has to do while it waits. Without being told, the opening Claude made
 * up its own wait: in the real test on 10-01 one ran a loop of 20 x `spoochie show` +
 * sleep 15 in the foreground, and Bea's answer, which the daemon put in its inbox in 8 s,
 * could not come in as a turn until the loop ended: 4 min 28 s late. Another ran it in
 * the background and took 27 s. The answer arrives on its own.
 */
const HOW_TO_WAIT = "Now end your turn. The answer will reach you on its own, as a new turn, as soon as the other person replies. Do not wait for it with `spoochie show`, sleep or loops: while a command of yours is running, it cannot come in.";

function rpc(req: any, timeoutMs = 60_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection({ path: DAEMON_SOCK });
    let buf = "";
    const fail = (e: Error) => { c.destroy(); reject(e); };
    c.setTimeout(timeoutMs, () => fail(new Error("the daemon is not answering")));
    c.on("error", fail);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) { c.destroy(); try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e as Error); } }
    });
  });
}

async function ensureDaemon() {
  ensureDirs();
  if (existsSync(DAEMON_SOCK)) {
    try { await rpc({ op: "ping" }, 1500); return; } catch {}
  }
  const { startDaemon } = await import("./startup.ts");
  startDaemon();
  // Under launchd the first start can be slow: if the previous daemon just died,
  // launchd waits out its ThrottleInterval (10 s) before trying again.
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { await rpc({ op: "ping" }, 1000); return; } catch {}
  }
  throw new Error(`could not start the daemon; see ${DAEMON_LOG}`);
}

/** Who I am: the session whose inbox socket is the one exported to me. */
function whoAmI(): SessionRecord {
  // Inside an aside Claude the CLI knows itself by the spoochie it handles: the daemon
  // wrote the record when it launched it, and it has no socket.
  if (envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE")) {
    const sid = envVar("SPOOCHIE_ASIDE_SESSION", "SPOOCHIE_APARTE_SESION");
    const aside = liveSessions().find(s => sid ? s.sessionId === sid : s.aparte === envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE"));
    if (aside) return aside;
    throw new Error(`this aside Claude (spoochie ${envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE")}) is no longer registered`);
  }
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!sock) throw new Error("no CLAUDE_CODE_MESSAGING_SOCKET: this has to run inside a Claude Code session");
  const me = liveSessions().find(s => s.socket === sock);
  if (!me) throw new Error("this session is not registered; it needs spoochie's SessionStart hook (and a session restart)");
  return me;
}

function git(cwd: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
  catch { return undefined; }
}

/** The fixed, small envelope: branch, SHA, touched files. Nothing else automatic:
 *  attaching too much is handy until the day a .env slips into the envelope. */
function autoContext(cwd: string) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return {};
  return {
    branch,
    sha: git(cwd, ["rev-parse", "HEAD"]),
    files: git(cwd, ["diff", "--name-only", "HEAD"])?.split("\n").filter(Boolean).slice(0, 12),
  };
}

/** Flags are looked up only among the arguments, never inside a message's text: a body
 *  that mentions "--human" must not change who signs.
 *  Up to 0.9.10 several flags were Spanish (`--seguir`, `--vincular`...). Each lookup
 *  takes the English name first and then the old ones, which still work. */
const args = (a: string[], positional: number) => a.slice(positional);
const flagIndex = (a: string[], names: string[]) => { for (const n of names) { const i = a.indexOf(`--${n}`); if (i >= 0) return i; } return -1; };
const flag = (a: string[], ...names: string[]) => { const i = flagIndex(a, names); return i >= 0 ? a[i + 1] : undefined; };
const has = (a: string[], ...names: string[]) => flagIndex(a, names) >= 0;
const fileList = (a: string[]) => flag(a, "files")?.split(",").map(f => rpath(f.trim())).filter(Boolean);

/** Subcommands that had Spanish names up to 0.9.10. The old name still works: an aside
 *  started by an older daemon has `portero` and `centinela` written in its hooks. */
const OLD_COMMANDS: Record<string, string> = {
  portero: "gatekeeper", centinela: "sentinel", rotar: "rotate", olvidar: "forget",
  llavero: "keychain", auditoria: "audit", confiar: "trust",
};
/** Flag values that are still stored in Spanish in config.json. */
const THREADS_VALUES: Record<string, "grupo" | "canal" | "dm"> = { group: "grupo", channel: "canal", dm: "dm", grupo: "grupo", canal: "canal" };
const LEVEL_VALUES: Record<string, "alto" | "normal"> = { high: "alto", normal: "normal", alto: "alto" };
const LAUNCHD_RESULT: Record<string, string> = { instalado: "installed", actualizado: "updated" };

function out(r: any) {
  if (r?.ok === false) { console.error(`spoochie: ${r.error}`); if (r.candidates) for (const c of r.candidates) console.error(`  - ${c}`); process.exit(1); }
  console.log(JSON.stringify(r, null, 2));
}

const USAGE = `spoochie - a tunnel between Claude Code sessions of different people

  spoochie sessions                          live sessions on this machine
  spoochie open <target[,target2,...]> --subject "..." --body "..." [--files a,b] [--follow <id>]
      several targets: N 1:1 tunnels sharing a group id, not a many-person channel
      --follow  continues an earlier spoochie: inherits the subject and says which one it follows.
                What was said there was erased on close and does not come back.
      target: a local session name, or @person for another machine (via Slack)
  spoochie take <id>                         keep a spoochie when you have several sessions
  spoochie accept <id>                       RUN BY THE RECEIVING HUMAN, not their Claude
  spoochie say <id> "<text>" [--files a,b]
      --human  ONLY if you are transcribing your user's literal words.
               What you write yourself goes without the flag: it is signed as their Claude.
  spoochie say <id> --file <path|->      for long texts, without fighting the quotes
  spoochie patch <id> [--diff-file f | --from-git]
  spoochie branch <id> <branch-name>
  spoochie release <id> | discard <id>   RUN BY THE RECEIVING HUMAN: releases or drops what the guardian held
  spoochie close <id> [--reason "..."]  |  spoochie close --group <g..>
  spoochie list | show <id>
  spoochie search "<text>"               searches the spoochies on this machine
  spoochie transcript <id> [--url <artifact-url>]
  spoochie selftest                      tests the whole loop here, without needing anyone
  spoochie rotate [--yes]                changes your signing key and tells your contacts
  spoochie forget @sam [--reason "..."]  drops them from your contacts and closes their spoochies
  spoochie keychain [on|off]             your keys and the token, in the macOS keychain
  spoochie audit [--n 50]                who opened, who accepted, what was held and who released it
  spoochie doctor                        checks what has to be right to deliver,
                                         and audits what should no longer be on disk
  spoochie config [--human "Edu"] [--guardian on|off] [--transcript on|off] [--aside on|off] [--copy on|off] [--erase on|off] [--transport nostr|slack] [--threads group|channel|dm] [--channel C0..]
  spoochie nostr [--relays wss://a,wss://b]      your Nostr key and your relays
  spoochie contacts [--forget-key <name>]        your contacts with their keys; forget one to re-invite
  spoochie contacts --level <name> high|normal   high trust: no "off the subject" notices
  spoochie contacts --bind <name|U0..> --npub <key>   their Nostr key by hand, when their join never arrived
  spoochie trust @sam --repo <repo> [--remove]  their spoochies about that repo come in without a dialog
  spoochie --version
      aside: incoming spoochies are handled by a Claude of their own; your session only sees the notice
  spoochie take <id> --here | accept <id> --here   THIS session answers, without an aside Claude

  Joining someone else, in one paste:
  spoochie invite --to <U0..|email> [--name Sam]   the bot DMs them the invite, with the steps
  spoochie invite                        or prints the line for you to send yourself
  spoochie join <string> [--user <U0..>] run by whoever is joining
      (paste the whole line, it cleans itself up; the string carries no token)

  Joining by hand, if you prefer the tokens one by one:
  spoochie slack setup --token xoxp-... --bot-token xoxb-...
  spoochie slack setup --token-file <path.json>     |   spoochie slack off
`;

async function main() {
  const [given, ...rest] = process.argv.slice(2);
  const cmd = OLD_COMMANDS[given] ?? given;
  if (cmd === "--version" || cmd === "-v" || cmd === "version") { const { VERSION } = await import("./version.ts"); console.log(VERSION); return; }

  // As a compiled binary there is no `bun run daemon.ts`: the daemon is this same
  // executable with `daemon`. Importing it starts it.
  if (cmd === "daemon") { await import("./daemon.ts"); return; }

  // The aside Claude's PreToolUse hook. Reads the event from stdin and answers with the
  // decision. It touches neither the daemon nor the registry: it is a pure function on
  // paper, and it has to answer even when everything else is broken, because if it does
  // not answer the tool runs.
  if (cmd === "gatekeeper") {
    const { gatekeeper } = await import("./gatekeeper.ts");
    const { cliCommand } = await import("./aside.ts");
    let input: unknown = null;
    try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch {}
    console.log(JSON.stringify(gatekeeper(input, cliCommand())));
    return;
  }

  // The aside Claude's Stop hook: it must not go quiet without having answered through the tunnel.
  if (cmd === "sentinel") {
    const { sentinel } = await import("./sentinel.ts");
    let input: unknown = null;
    try { input = JSON.parse(await new Response(Bun.stdin.stream()).text()); } catch {}
    console.log(JSON.stringify(sentinel(input, envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE"), envVar("SPOOCHIE_ASIDE_SESSION", "SPOOCHIE_APARTE_SESION"))));
    return;
  }

  if (cmd === "register") {
    // From the hook, the event comes on stdin. Run by hand from a terminal nothing comes,
    // and reading stdin hung forever: the session's env already has the only thing
    // needed, so it is not even tried.
    const raw = process.stdin.isTTY ? "{}" : await new Response(Bun.stdin.stream()).text().catch(() => "{}");
    const ev = raw.trim() ? JSON.parse(raw) : {};
    const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    if (!socket || !token) { console.error("spoochie: this session has no inbox; not registering"); return; }
    const cwd: string = ev.cwd ?? process.cwd();
    // An aside Claude's window: replaces the provisional record the daemon left with one
    // that has a socket, and the daemon hands it what it was holding. It claims no
    // spoochies and does not touch launchd. What gets printed goes into its context.
    if (envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE")) {
      const id = envVar("SPOOCHIE_ASIDE", "SPOOCHIE_APARTE");
      register({
        sessionId: envVar("SPOOCHIE_ASIDE_SESSION", "SPOOCHIE_APARTE_SESION") ?? `aparte-${id}`, name: `aparte-${id}`, cwd, socket, token,
        pid: Number(socket.split("/").pop()!.replace(/\.sock$/, "")) || process.ppid, startedAt: Date.now(), aparte: id,
      });
      console.log(`spoochie: this window is the aside Claude for spoochie ${id}. The first turn is arriving now through the tunnel.`);
      return;
    }
    const sessionId: string = ev.session_id ?? socket;
    register({
      sessionId,
      // The last characters, not the first: with ids like "sim-a" and "sim-b" the
      // prefix is identical and the name lost exactly what tells them apart.
      name: `${cwd.split("/").pop()}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-4)}`,
      cwd, socket, token,
      // The socket's name is the PID of the claude process: /tmp/cc-socks/<pid>.sock
      // Checked on 2.1.251. An exact sign of life, without depending on the process tree.
      pid: Number(socket.split("/").pop()!.replace(/\.sock$/, "")) || process.ppid,
      startedAt: Date.now(),
    });
    // On macOS the daemon moves to launchd, which keeps it alive and starts it at boot.
    // It is done here, on every session start, because the plugin path changes with
    // every version and the plist has to follow it.
    try { const { installLaunchd } = await import("./startup.ts"); const r = installLaunchd(); if (r !== "igual" && r !== "no") console.error(`spoochie: daemon ${LAUNCHD_RESULT[r] ?? r} in launchd`); } catch {}
    await ensureDaemon();
    try { await rpc({ op: "claim", sessionId }, 5000); } catch {}
    return;
  }

  if (cmd === "unregister") {
    const raw = await new Response(Bun.stdin.stream()).text().catch(() => "{}");
    const ev = raw.trim() ? JSON.parse(raw) : {};
    const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    const id = envVar("SPOOCHIE_ASIDE_SESSION", "SPOOCHIE_APARTE_SESION") ?? ev.session_id ?? liveSessions().find(s => s.socket === sock)?.sessionId;
    if (!id) return;
    try { await rpc({ op: "session-end", sessionId: id }, 5000); } catch {}
    unregister(id);
    return;
  }

  if (cmd === "config") {
    const c = Cfg.load();
    if (flag(rest, "human")) c.human = flag(rest, "human");
    if (flag(rest, "guardian")) c.guardian = flag(rest, "guardian") === "on";
    if (flag(rest, "transcript")) c.transcript = flag(rest, "transcript") === "on";
    if (flag(rest, "aside", "aparte")) c.aparte = flag(rest, "aside", "aparte") === "on";
    if (flag(rest, "copy", "copia")) c.aparteCopia = flag(rest, "copy", "copia") === "on";
    if (flag(rest, "erase", "borrar")) c.borrarAlCerrar = flag(rest, "erase", "borrar") === "on";
    if (flag(rest, "transport", "transporte")) {
      const v = flag(rest, "transport", "transporte");
      if (v !== "nostr" && v !== "slack") { console.error("spoochie: --transport nostr | slack"); process.exit(1); }
      c.transporte = v;
    }
    const threads = flag(rest, "threads", "hilos");
    if (threads && c.slack) {
      const stored = THREADS_VALUES[threads];
      if (!stored) { console.error("spoochie: --threads group | channel | dm"); process.exit(1); }
      c.slack.hilos = stored;
    }
    if (flag(rest, "channel", "canal") && c.slack) c.slack.canal = flag(rest, "channel", "canal");
    Cfg.save(c);
    console.log(JSON.stringify({
      ...c,
      slack: c.slack ? {
        userId: c.slack.userId,
        hilos: c.slack.hilos ?? "grupo",
        canal: c.slack.canal,
        origen: c.slack.tokenFile ? `${c.slack.tokenFile} (${c.slack.tokenKey})` : "token stored here",
        valido: Boolean(Cfg.slackToken(c)),
      } : undefined,
    }, null, 2));
    return;
  }

  // ── Joining in a single paste ─────────────────────────────────────────────
  //
  // The long road (installing the app yourself, pulling two tokens from a Slack screen
  // that needs admin access) is not needed: the user token was only there to look people
  // up, and the bot does that if the app has users:read. So the only thing to hand
  // someone is the bot token, which belongs to the app, not to them.
  if (cmd === "invite") {
    const c = Cfg.load();
    const bot = Cfg.slackBotToken(c);
    const { createInvite, inviteText, inviteData } = await import("./join.ts");
    const { myKeys } = await import("./signing.ts");
    const N = await import("./nostr.ts");
    const nk = N.myKeys(c);
    Cfg.save(c);
    // The first invite is the one that creates the Nostr key, and this machine's daemon
    // started earlier, without it: unless told, it does not listen, and the newcomer's
    // hello stays on the relays. Measured in the real test: 4 minutes without Bea's key;
    // after the reload it came in within 1 s.
    if (existsSync(DAEMON_SOCK)) await rpc({ op: "slack-reload" }).catch(() => {});
    const self = { id: c.slack?.userId ?? `nostr:${nk.pk}`, name: c.human ?? userInfo().username, pk: myKeys(c).pub, np: nk.pk, r: N.myRelays(c) };
    // Without Slack: a Nostr-only invite, to send any way you like. There is no DM to
    // send; it gets printed and that is it.
    if (!bot || !c.slack?.userId) {
      const { newInvite } = await import("./keys.ts");
      const k = newInvite(c, { name: flag(rest, "name") });
      Cfg.save(c);
      const blob = createInvite({ n: flag(rest, "name"), i: self, k });
      console.log(inviteText(blob, self.name));
      console.log(`\n(No Slack: send them this any way you like. When they paste it, their key will reach you over Nostr and you can write to @${Cfg.contactKey(flag(rest, "name") ?? "name")}.)`);
      return;
    }
    const { whoIs } = await import("./slack.ts");
    const team = await whoIs(bot);
    if (!team) { console.error("the bot token you have is not valid (auth.test)"); process.exit(1); return; }
    const api = (m: string, body: unknown) => fetch(`https://slack.com/api/${m}`, {
      method: "POST", headers: { authorization: `Bearer ${bot}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json());

    // With --to, the bot DMs them the invite with the steps inside. That way there is
    // nothing to copy, and since the invite already says who it is for, the join does
    // not have to look itself up in Slack (that needs users:read, a scope that may be missing).
    const to = flag(rest, "to");
    if (to) {
      let dest: { id: string; name: string } | null = Cfg.contact(c, to);
      if (!dest && /^[UW][A-Z0-9]{6,}$/.test(to)) {
        // Without users:read the name cannot come from Slack; the inviter supplies it with --name.
        const r = await api("users.info", { user: to });
        const name = flag(rest, "name") ?? (r.ok ? (r.user?.profile?.real_name ?? r.user?.name) : undefined);
        if (!name) { console.error(`the app cannot read ${to}'s name; tell me yourself:  spoochie invite --to ${to} --name Sam`); process.exit(1); return; }
        dest = { id: to, name };
      }
      if (!dest && to.includes("@")) {
        const r = await api("users.lookupByEmail", { email: to });
        if (r.ok) dest = { id: r.user.id, name: r.user.profile?.real_name ?? r.user.name };
        else if (r.error === "missing_scope") console.error(`the app cannot look people up by email (the bot is missing users:read.email).`);
      }
      if (!dest) {
        console.error(`I don't know who to send it to: pass their Slack id, --to U01234567 (it is on their profile, "Copy member ID").`);
        process.exit(1); return;
      }
      const { newInvite } = await import("./keys.ts");
      const k = newInvite(c, dest);
      Cfg.save(c);
      const blob = createInvite(inviteData({ team: team.team, dest, yo: self, k }));
      const im = await api("conversations.open", { users: dest.id });
      if (!im.ok) { console.error(`cannot open the DM with ${dest.name}: ${im.error}`); process.exit(1); return; }
      const post = await api("chat.postMessage", { channel: im.channel.id, text: inviteText(blob, self.name) });
      if (!post.ok) { console.error(`could not send the DM: ${post.error}`); process.exit(1); return; }
      Cfg.addContact(c, dest); Cfg.save(c);
      console.log(`Sent to ${dest.name} by the bot's DM, with the steps inside. You can now write to @${Cfg.contactKey(dest.name)}.`);
      return;
    }

    const { newInvite } = await import("./keys.ts");
    const k = newInvite(c, { name: flag(rest, "name") });
    Cfg.save(c);
    const blob = createInvite({ t: team.team, i: self, k });
    console.log(`Send this to whoever you want to bring in. It is one line:\n`);
    console.log(`  /spoochie:join ${blob}\n`);
    console.log(`It carries your public keys and nothing else: no password, no token.`);
    console.log(`Since the string carries no token, the newcomer has to say who they are in Slack: they add --user <their Slack id>.`);
    console.log(`Easier: spoochie invite --to <their id>, and the bot DMs them the invite already filled in.`);
    return;
  }

  if (cmd === "join") {
    const { cleanString, readInvite } = await import("./join.ts");
    // Everything pasted gets cleaned, not just rest[0]: the newcomer pastes the whole
    // line as it was sent, with "spoochie join" in front and Slack's quotes.
    const blob = cleanString(rest.join(" "));
    if (!blob) {
      console.error("I don't see any invite in what you pasted.");
      console.error("Ask whoever is bringing you in to run `spoochie invite` and send you the whole line.");
      process.exit(2); return;
    }
    const invite = readInvite(blob);
    if (!invite) { console.error("that string is not a spoochie invite"); process.exit(2); return; }

    // An invite from 0.9.7 or earlier made with --con-slack carried the bot token inside.
    // Here it is thrown away: accepting a whole team's credential because it came in a
    // pasted string is exactly what we stopped doing. It is said out loud, because the
    // sender has to know they handed it out and must rotate it.
    if (invite.traiaToken) {
      console.error(`Careful: that invite carries the team's Slack bot token. I did not store it.`);
      console.error(`Tell whoever sent it: that credential travelled through a DM and has to be rotated in the Slack app.`);
    }

    // Your Slack id: the one the inviter put in, or the one you pass. Without a token
    // there is nothing to ask Slack, so it is no longer looked up by email.
    const userId = flag(rest, "user") ?? invite.u;

    const c = Cfg.load();
    // The Slack id works without a token: it goes in the hello so whoever writes to me
    // notifies me by DM with their bot, and so Slack stays the place where I find out.
    if (userId && !c.slack?.botToken) c.slack = { ...c.slack, userId };
    // The name: the one from --name, the one the inviter put in, and failing that the
    // system user (which in the first real test showed up as the machine's user all over the thread).
    if (!c.human || c.human === userInfo().username) c.human = flag(rest, "name", "nombre") ?? invite.n ?? c.human ?? userInfo().username;
    if (invite.i) Cfg.addContact(c, { id: invite.i.id, name: invite.i.name, pk: invite.i.pk, npub: invite.i.np, relays: invite.i.r });
    const { myKeys } = await import("./signing.ts");
    myKeys(c);
    const N = await import("./nostr.ts");
    const nk = N.myKeys(c);
    Cfg.save(c);
    if (invite.i) console.log(`${invite.i.name} invited you: you can now write to @${Cfg.contactKey(invite.i.name)}.`);
    if (userId) console.log(`Done${invite.t ? ` in ${invite.t}` : ""}, as ${userId}. Slack notices come from the bot of whoever writes to you.`);
    else console.log(`Done. You did not tell me your Slack id, so there will be no DM notices: pass it with --user U01234567 and paste the invite again.`);
    console.log(`Your Nostr key: ${N.npub(nk.pk)} (relays: ${N.myRelays(c).join(", ")}).`);
    // The hello: the inviter gets my key over Nostr and can open encrypted spoochies to me.
    if (invite.i?.np) {
      const b = new N.NostrBridge(nk.sk, nk.pk, N.myRelays(c), { onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {} },
        process.env.SPOOCHIE_NOSTR_DIR ? N.filePool(process.env.SPOOCHIE_NOSTR_DIR) : undefined);
      const ok = await b.hello(invite.i.np, invite.i.r ?? [], c.human ?? userInfo().username, userId, invite.k);
      b.close();
      console.log(ok ? `Sent your key to ${invite.i.name} over Nostr.` : `Could not send your key over Nostr (no network to the relays); ${invite.i.name} will have to add you with --npub.`);
    }
    try { const { installLaunchd } = await import("./startup.ts"); installLaunchd(); } catch {}
    await ensureDaemon();
    await rpc({ op: "slack-reload" }).catch(() => {});

    // The check lives in here on purpose: joining without knowing whether it delivers
    // is half a step, and half a step is the one nobody takes.
    console.log(`\nChecking that it really delivers...\n`);
    const { selftest } = await import("./selftest.ts");
    let failed = 0;
    for (const p of await selftest()) {
      if (!p.ok) failed++;
      console.log(`${p.ok ? "  ok " : "FAIL "}  ${p.what.padEnd(38)} ${p.detail}`);
    }
    console.log(failed ? `\n${failed} failures: spoochie is not ready.` : "\nAll good. spoochie delivers on this machine.");
    process.exit(failed ? 1 : 0);
  }

  if (cmd === "nostr") {
    const N = await import("./nostr.ts");
    const c = Cfg.load();
    const k = N.myKeys(c);
    const relays = flag(rest, "relays");
    if (relays) { c.nostr = { ...c.nostr, relays: relays.split(",").map(s => s.trim()).filter(s => /^wss?:\/\//.test(s)) }; }
    Cfg.save(c);
    console.log(JSON.stringify({ npub: N.npub(k.pk), pk: k.pk, relays: N.myRelays(c), transporte: c.transporte ?? "nostr (if the other side has a key)" }, null, 2));
    return;
  }

  // The record of what people decided. Facts and names only: never the text of the
  // messages, because erase-on-close has to stay true.
  if (cmd === "audit") {
    const { read, FILE } = await import("./audit.ts");
    const n = Number(flag(rest, "n") ?? 50);
    const lines = read(n);
    if (!lines.length) { console.log(`(nothing recorded yet; the record lives in ${FILE})`); return; }
    for (const l of lines) {
      console.log(`${l.cuando.slice(0, 19).replace("T", " ")}  ${l.hecho.padEnd(15)} ${l.id.padEnd(8)} ${l.quien.padEnd(14)} ${l.detalle}`);
    }
    console.log(`\n${FILE} · not erased when a spoochie closes: these are facts, not conversation.`);
    return;
  }

  // Secrets go to the macOS keychain (see `keychain` below). By hand and reversible: an
  // automatic migration of someone's keys, if it goes wrong, locks them out of their
  // contacts with no way back.
  // Changing your signing key without the whole team having to re-invite you.
  if (cmd === "rotate") {
    const c = Cfg.load();
    const { newKeys, myKeys } = await import("./signing.ts");
    const old = myKeys(c);
    const bot = Cfg.slackBotToken(c);
    if (!bot || !c.slack?.userId) { console.error("the rotation is announced through the bot's DM, and there is no Slack set up here"); process.exit(1); return; }
    const contacts = Object.values(c.contacts ?? {}).filter(x => x.pk && !x.id.startsWith("nostr:"));
    if (!has(rest, "yes", "si")) {
      console.log(`You are about to change your signing key. ${contacts.length} contact(s) would be told, signed with the old key.`);
      console.log(`Each one checks it against the key of yours they already have and keeps the new one.`);
      console.log(`If your old key was stolen, the thief can sign that too: that is why the DM says so in plain text and tells them to ask.`);
      console.log(`\nWhen you are sure:  spoochie rotate --yes`);
      return;
    }
    const { SlackBridge } = await import("./slack.ts");
    const fresh = newKeys();
    const bridge = SlackBridge.fromConfig(async () => {}, async () => {}, async () => {}, () => {}, async () => {});
    if (!bridge) { console.error("cannot open the Slack bridge"); process.exit(1); return; }
    let n = 0;
    for (const x of contacts) {
      const ok = await bridge.rotate(x.id, fresh.pub, old.priv, old.pub, c.human ?? "someone");
      if (ok) n++; else console.error(`could not notify ${x.name}`);
    }
    c.keys = fresh;
    Cfg.save(c);
    const { record } = await import("./audit.ts");
    record("clave-fijada", "-", c.human ?? "this machine", `own rotation · notified ${n}/${contacts.length}`);
    console.log(`New key in place and announced to ${n} of ${contacts.length} contact(s).`);
    if (n < contacts.length) console.log(`Those who did not hear about it will have to run  spoochie contacts --forget-key ${c.human ?? ""}  and re-invite you.`);
    return;
  }

  // Dropping someone from your contacts: closes their spoochies and stops knowing them.
  if (cmd === "forget") {
    const who = (rest[0] ?? "").replace(/^@/, "");
    if (!who) { console.error('usage:  spoochie forget @sam [--reason "left the team"]'); process.exit(2); return; }
    const r = await rpc({ op: "olvidar", sessionId: (() => { try { return whoAmI().sessionId; } catch { return undefined; } })(), quien: who, motivo: flag(rest, "reason", "motivo") });
    if (r?.ok === false) { console.error(`spoochie: ${r.error}`); process.exit(1); return; }
    console.log(`${r.quien} is no longer in your contacts${r.cerrados.length ? `, and ${r.cerrados.length} spoochie(s) were closed: ${r.cerrados.join(", ")}` : ""}.`);
    console.log(`Whatever they send from now on is dropped: an envelope from an id that is not in the contacts does not get in.`);
    console.log(`With no server there is no team-wide revocation: each machine drops whoever it wants from its own.`);
    return;
  }

  if (cmd === "keychain") {
    const L = await import("./keychain.ts");
    const c = Cfg.load();
    const action = rest[0];
    if (!L.available()) { console.error("the keychain only exists on macOS (and needs the `security` command)"); process.exit(1); return; }
    if (action === "on") {
      const moved = Cfg.toKeychain(c);
      Cfg.save(c);
      console.log(moved.length ? `To the keychain: ${moved.join(", ")}. config.json keeps "${L.MARKER}" in their place.` : "There was nothing to move.");
      return;
    }
    if (action === "off") {
      const back = Cfg.fromKeychain(c);
      Cfg.save(c);
      console.log(back.length ? `Back in config.json: ${back.join(", ")}. They are in plain text again, at 0600.` : "There was nothing of spoochie's in the keychain.");
      return;
    }
    const status = Object.entries(L.ACCOUNTS).map(([k, account]) => `${k.padEnd(6)} ${L.read(account) ? "in the keychain" : "in config.json"}`);
    console.log(status.join("\n"));
    console.log(`\nspoochie keychain on   moves them to the macOS keychain`);
    console.log(`spoochie keychain off  puts them back in config.json`);
    return;
  }

  if (cmd === "contacts") {
    const c = Cfg.load();
    // The way out when a join never arrives: a hello from a 0.9.8 without the nonce, or
    // one lost on the way. The person pastes the key, since they are the one who can
    // have checked it with the other side; `spoochie doctor` shows the one that arrived.
    const bind = flag(rest, "bind", "vincular");
    if (bind) {
      const N = await import("./nostr.ts");
      const { bindKey } = await import("./keys.ts");
      const Strangers = await import("./strangers.ts");
      const who = Cfg.contact(c, bind.replace(/^@/, "")) ?? Cfg.contactById(c, bind);
      if (!who) { console.error(`I have nobody called ${bind} in the contacts: invite them first (spoochie invite --to <their id>)`); process.exit(1); return; }
      const pk = N.pkOf(flag(rest, "npub") ?? "");
      if (!pk) { console.error(`their key is missing: --npub npub1... or the 64 hex characters (spoochie doctor shows the one that arrived)`); process.exit(1); return; }
      const v = bindKey(c, { id: who.id, name: who.name, npub: pk, relays: N.DEFAULT_RELAYS });
      if (v === "conflicto") { console.error(`not binding it: either ${who.name} already has another key, or that key belongs to another contact. If it has to change: spoochie contacts --forget-key ${Cfg.contactKey(who.name)}`); process.exit(1); return; }
      // Their invite is no longer needed: leaving it alive leaves a nonce that lets keys in.
      for (const [k, inv] of Object.entries(c.invitaciones ?? {})) if (inv.id === who.id) delete c.invitaciones![k];
      Cfg.save(c);
      Strangers.forget(pk);
      console.log(`${v === "igual" ? "Already had it" : "Bound"}: ${who.name} is the key ${pk.slice(0, 8)}...${pk.slice(-4)}. If you have not done so, check with ${who.name} that their \`spoochie nostr\` shows that same one.`);
      return;
    }
    const forget = flag(rest, "forget-key", "olvidar-clave");
    if (forget) {
      const k = Cfg.contactKey(forget);
      const x = c.contacts?.[k];
      if (!x) { console.error(`I have nobody called @${k}`); process.exit(1); return; }
      delete x.npub; delete x.relays;
      Cfg.save(c);
      console.log(`Forgot ${x.name}'s Nostr key. With ${x.name} it goes over Slack until you invite them again (spoochie invite --to ${x.id}).`);
      return;
    }
    const Trust = await import("./trust.ts");
    const levelOf = flag(rest, "level", "nivel");
    if (levelOf) {
      const given = rest[flagIndex(rest, ["level", "nivel"]) + 2];
      const level = LEVEL_VALUES[given];
      if (!level) { console.error("the level is `high` or `normal`:  spoochie contacts --level <name> high"); process.exit(2); return; }
      const r = Trust.setLevel(c, levelOf, level);
      if (!r.ok) { console.error(r.error); process.exit(1); return; }
      Cfg.save(c);
      console.log(level === "alto"
        ? `${levelOf} now has high trust: their off-subject messages no longer notify you in the thread. Anything that asks for action is still held the same way; that does not depend on trust.`
        : `${levelOf} is back to normal trust.`);
      return;
    }
    for (const [k, x] of Object.entries(c.contacts ?? {})) {
      const extra = [
        // When they were last heard from. It does not say whether they are here now, it
        // says when they were: the closest thing to "presence" without inventing a poll.
        x.visto ? `seen ${Trust.ago(x.visto)}` : null,
        x.nivel === "alto" ? "trust:high" : null,
        x.auto?.length ? `auto-accepted: ${x.auto.join(",")}` : null,
      ].filter(Boolean).join("  ");
      console.log(`@${k.padEnd(14)} ${x.name.padEnd(16)} ${x.id.padEnd(12)} signature:${x.pk ? "pinned" : "no    "}  nostr:${x.npub ? `${x.npub.slice(0, 12)}... (${(x.relays ?? []).length} relays)` : "no key"}${extra ? "  " + extra : ""}`);
    }
    const pending = Object.entries(c.invitaciones ?? {});
    if (pending.length) console.log(`\n${pending.length} unredeemed invite${pending.length === 1 ? "" : "s"}: ${pending.map(([, v]) => v.name ?? v.id ?? "?").join(", ")}`);
    return;
  }

  // Permanent, scoped consent. Per person AND per repo: a bare "I trust Sam" would be a
  // master key to every machine you work on.
  if (cmd === "trust") {
    const c = Cfg.load();
    const who = (rest[0] ?? "").replace(/^@/, "");
    const repo = flag(rest, "repo");
    if (!who || !repo) {
      console.error("usage:  spoochie trust @sam --repo <repo-name> [--remove]");
      console.error("That person's spoochies about that repo will come in without showing you the dialog.");
      console.error("Anything that asks for action is still held the same way: trust does not open that door.");
      process.exit(2); return;
    }
    const { trust } = await import("./trust.ts");
    const r = trust(c, who, repo, has(rest, "remove", "quitar"));
    if (!r.ok) { console.error(r.error); process.exit(1); return; }
    Cfg.save(c);
    console.log(r.repos.length
      ? `${who}'s spoochies about ${r.repos.join(", ")} come in without asking you. Each one says so in the thread when it happens.`
      : `${who} goes back through the dialog in every repo.`);
    return;
  }

  if (cmd === "slack") {
    const c = Cfg.load();
    if (rest[0] === "off") { delete c.slack; Cfg.save(c); console.log("Slack turned off"); }
    else if (rest[0] === "setup") {
      const tokenFile = flag(rest, "token-file");
      const tokenKey = flag(rest, "token-key") ?? "userToken";
      const botTokenKey = flag(rest, "bot-token-key") ?? "botToken";
      let token = flag(rest, "token");
      let botToken = flag(rest, "bot-token");
      if (tokenFile) {
        try {
          const j = JSON.parse(readFileSync(rpath(tokenFile), "utf8"));
          token = j[tokenKey]; botToken = j[botTokenKey];
        } catch { console.error(`cannot read ${tokenFile}`); process.exit(1); }
        if (!token) { console.error(`${tokenFile} has no "${tokenKey}" key`); process.exit(1); }
      }
      if (!token || !botToken) {
        console.error("spoochie needs two tokens from the same Slack app:");
        console.error("  --token xoxp-...      yours, a user token. Only used to look people up.");
        console.error("  --bot-token xoxb-...  the app's. Posts and reads the threads.");
        console.error("Or both from a file:  --token-file <path.json>");
        process.exit(2);
      }
      // Both are checked before saving anything: a setup that says "done" and then does
      // not deliver is worse than one that fails here.
      const { whoIs } = await import("./slack.ts");
      const me = await whoIs(token);
      if (!me) { console.error("the user token is not valid: Slack won't tell me who you are (auth.test)"); process.exit(1); }
      const bot = await whoIs(botToken);
      if (!bot) { console.error("the bot token is not valid (auth.test)"); process.exit(1); }
      const user = flag(rest, "user") ?? me.userId;
      console.log(`You are ${me.user} in ${me.team} (${user}), and the bot is ${bot.user}`);
      if (!c.human) c.human = me.user;
      c.slack = tokenFile
        ? { tokenFile: rpath(tokenFile), tokenKey, botTokenKey, userId: user, pollMs: 20_000 }
        : { userToken: token, botToken, userId: user, pollMs: 20_000 };
      Cfg.save(c);
      await ensureDaemon();
      out(await rpc({ op: "slack-reload" }));
    } else console.log(USAGE);
    return;
  }

  await ensureDaemon();

  switch (cmd) {
    case "sessions": {
      const r = await rpc({ op: "sessions" });
      for (const s of r.sessions) console.log(`${s.name.padEnd(24)} ${s.cwd}`);
      break;
    }
    case "open": {
      const me = whoAmI();
      const [to] = rest;
      const subject = flag(rest, "subject"), body = flag(rest, "body");
      if (!to || !subject || !body) { console.error("missing arguments\n" + USAGE); process.exit(2); }
      // The same question to several people: `spoochie open @sam,@ana --subject ...`.
      // They are N real 1:1 tunnels, each with its own dialog and consent; what they
      // share is a group id, so the answers arrive together and can be closed at once.
      // There is no "many-person channel": that would make each person see what the
      // others say, and nobody agreed to that.
      const targets = to.split(",").map(x => x.trim()).filter(Boolean);
      if (targets.length > 1) {
        const group = `g${Date.now().toString(36)}`;
        const opened: string[] = [];
        for (const d of targets) {
          const r = await rpc({ op: "open", sessionId: me.sessionId, to: d, subject, body, files: fileList(rest), context: autoContext(me.cwd), grupo: group });
          if (r?.ok) { opened.push(`${r.id} -> ${d}`); }
          else console.error(`${d}: ${r?.error ?? "could not open"}`);
        }
        if (!opened.length) process.exit(1);
        console.log(JSON.stringify({ ok: true, grupo: group, abiertos: opened }, null, 2));
        console.log(`\nThese are ${opened.length} 1:1 tunnels, not a channel: each person sees only their own and accepts on their own.`);
        console.log(`Answers reach you tagged with the group. To close them all:  spoochie close --group ${group}`);
        break;
      }
      const r = await rpc({ op: "open", sessionId: me.sessionId, to, subject, body, files: fileList(rest), context: autoContext(me.cwd), seguir: flag(rest, "follow", "seguir") });
      out(r);
      // The daemon builds the HTML but cannot publish it: Artifact is a tool of the
      // Claude session, not of a standalone process. So it is asked for here, because
      // otherwise the transcript stays on disk and nobody sees the link.
      if (r?.ok && Cfg.load().transcript) {
        console.log(`\nNEXT STEP, do it now: publish ${join(TRANSCRIPTS_DIR, `${r.id}.html`)} with the Artifact tool`);
        console.log(`and then register the URL so it shows up in the Slack thread:`);
        console.log(`  spoochie transcript ${r.id} --url <url>`);
      }
      if (r?.ok) console.log(`\n${HOW_TO_WAIT}`);
      break;
    }
    case "take":
    case "accept": {
      const r = await rpc({ op: cmd, sessionId: whoAmI().sessionId, id: rest[0], by: Cfg.load().human, aqui: has(rest, "here", "aqui") });
      out(r);
      if (r?.ok && r.aparte) {
        console.log(r.ventana
          ? `An aside Claude handles it in a NEW terminal WINDOW, in ${r.aparte}. Nothing more from this spoochie reaches this session: do nothing, carry on with your work.`
          : `An aside Claude handles it in the background in ${r.aparte}. Nothing more from this spoochie reaches this session. It shows in Slack and with  spoochie show ${rest[0]}.`);
      }
      break;
    }
    case "say": {
      const me = whoAmI();
      const id = rest[0];
      const f = flag(rest, "file");
      // The text is the first argument that is not a flag. It used to be plain rest[1],
      // and a `say <id> --human` with no text sent "--human" as the message.
      const text = f
        ? (f === "-" ? await new Response(Bun.stdin.stream()).text() : readFileSync(rpath(f), "utf8"))
        : rest.slice(1).find(a => !a.startsWith("--"));
      if (!id || !text?.trim()) { console.error("the message text is missing\n" + USAGE); process.exit(2); }
      if (text.length > MAX_MESSAGE) { console.error(`the message is over ${MAX_MESSAGE} characters (${text.length}). Cut it yourself or send a patch.`); process.exit(2); }
      const r = await rpc({ op: "say", sessionId: me.sessionId, id, text, files: fileList(rest), author: has(args(rest, 2), "human") ? "human" : "claude" });
      out(r);
      if (r?.delivered === "publicado") console.log("Posted in the Slack thread. The other side's answer will reach you here as one more turn; there is nothing to do.");
      else if (r?.delivered === "encolado") console.log("Queued: it goes out to Slack in a few seconds. If it failed, I would tell you right here. Don't treat it as stuck.");
      else if (r?.delivered === "retenido") console.log("Held by the other side's guardian until their person releases it.");
      break;
    }
    case "patch": {
      const me = whoAmI();
      const id = rest[0];
      const f = flag(rest, "diff-file");
      const diff = f ? readFileSync(rpath(f), "utf8") : git(me.cwd, ["diff", "HEAD"]);
      if (!diff?.trim()) { console.error("there is no diff to send"); process.exit(2); }
      // Over Slack a patch bigger than this arrived cut, with a "continues in the
      // transcript" the other side cannot apply. Better to say so here.
      if (diff.length > MAX_PATCH) {
        console.error(`the patch is ${diff.length} characters and the tunnel fits ${MAX_PATCH}.`);
        console.error(`Push the branch and send it:  spoochie branch ${id ?? "<id>"} <branch>`);
        process.exit(2);
      }
      out(await rpc({ op: "say", sessionId: me.sessionId, id, text: diff, kind: "patch" }));
      break;
    }
    case "branch":
      out(await rpc({ op: "say", sessionId: whoAmI().sessionId, id: rest[0], text: rest[1], kind: "branch" }));
      break;
    case "release":
    case "discard":
      out(await rpc({ op: cmd, sessionId: whoAmI().sessionId, id: rest[0] }));
      break;
    case "close": {
      const group = flag(rest, "group", "grupo");
      if (group) {
        const r = await rpc({ op: "close-grupo", sessionId: whoAmI().sessionId, grupo: group, reason: flag(rest, "reason") });
        out(r);
        break;
      }
      out(await rpc({ op: "close", sessionId: whoAmI().sessionId, id: rest[0], reason: flag(rest, "reason") }));
      break;
    }
    case "list": {
      let sessionId: string | undefined;
      try { sessionId = whoAmI().sessionId; } catch {}
      const r = await rpc({ op: "list", sessionId });
      if (!r.threads.length) { console.log("(no spoochies)"); break; }
      for (const t of r.threads)
        console.log(`${t.id}  ${t.state.padEnd(8)} ${t.from} -> ${t.to}  "${t.subject}"  (${t.messages} msg, expires in ${t.expiresInSec}s)${t.transcript ? `  ${t.transcript}` : ""}`);
      break;
    }
    case "selftest": {
      const { selftest } = await import("./selftest.ts");
      console.log("Testing the whole loop on this machine, without touching Slack or your state.\n");
      let failed = 0;
      for (const p of await selftest()) {
        if (!p.ok) failed++;
        console.log(`${p.ok ? "  ok " : "FAIL "}  ${p.what.padEnd(38)} ${p.detail}`);
      }
      console.log(failed ? `\n${failed} failures: spoochie is not ready.` : "\nAll good. spoochie delivers on this machine.");
      if (failed) process.exit(1);
      break;
    }
    case "doctor": {
      const { check } = await import("./doctor.ts");
      let failed = 0;
      for (const c of await check()) {
        const mark = c.ok === true ? "  ok " : c.ok === "warn" ? " note" : "FAIL ";
        if (c.ok === false) failed++;
        console.log(`${mark}  ${c.what.padEnd(26)} ${c.detail}`);
      }
      if (failed) process.exit(1);
      break;
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) { console.error("search for what?\n" + USAGE); process.exit(2); }
      const r = await rpc({ op: "search", q });
      if (!r.hits.length) { console.log(`(nothing with "${q}")`); break; }
      for (const h of r.hits) {
        console.log(`${h.id}  ${h.cuando}  ${h.state.padEnd(7)} ${h.con}`);
        console.log(`      "${h.subject}"${h.rama ? `  [${h.rama}]` : ""}  (matches in the ${h.donde})`);
        if (h.extracto) console.log(`      ${h.extracto}`);
        if (h.transcript) console.log(`      ${h.transcript}`);
      }
      break;
    }
    case "show":
      out(await rpc({ op: "get", id: rest[0] }));
      break;
    case "transcript": {
      const id = rest[0];
      const url = flag(rest, "url");
      if (url) {
        // Checked here too, not only in the daemon: the error reads better where the
        // command was typed, and whoever types it is usually a Claude.
        const v = transcriptUrlOf(url);
        if (!v.ok) { console.error(`spoochie transcript --url: ${v.error}`); process.exit(1); }
        out(await rpc({ op: "transcript-url", id, url: v.url, sessionId: whoAmI().sessionId }));
        break;
      }
      const p = join(TRANSCRIPTS_DIR, `${id}.html`);
      if (!existsSync(p)) { console.error(`there is no transcript for ${id} (turn it on with: spoochie config --transcript on)`); process.exit(1); }
      console.log(p);
      console.log(`Publish it with the Artifact tool and save the URL:  spoochie transcript ${id} --url <url>`);
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch(e => { console.error(`spoochie: ${e.message}`); process.exit(1); });
