import { ORIGIN } from "./origin.ts";

/** What travels in the invite. `u` is who it is for (so the join does not have to look
 *  itself up in Slack, which needs a scope the app may not have) and `i` is the inviter,
 *  so "@edu" resolves locally without calling Slack. */
export type Invite = {
  t?: string; u?: string; n?: string;
  /** Only when reading: the string carried a bot token (an invite from 0.9.7 or earlier
   *  made with --con-slack). Not stored; it is reported, because whoever sent it should
   *  know they handed out a team credential in a DM. */
  traiaToken?: boolean;
  /** Single-use nonce: the joiner's hello sends it back, and without it no key gets into
   *  the inviter's contacts (keys.ts). */
  k?: string;
  /** The inviter: Slack id (or "nostr:<pk>"), name, ed25519 key, Nostr key and relays. */
  i?: { id: string; name: string; pk?: string; np?: string; r?: string[] };
};

/**
 * What goes inside an invite. Never a secret.
 *
 * The string is base64 JSON: anyone can open it with a decoder, and a teammate did on day
 * one and saw the app token. 0.9.7 took it out of the normal path and left `--con-slack`
 * to put it back in; a flag that hands out a whole-team credential in a DM is the same
 * leak, just on request. A newcomer does not need the token: their daemon talks
 * encrypted over the relays, and the DM notices come from the bot of whoever writes to
 * them.
 *
 * What is lost: someone joining today cannot talk to someone still on the Slack
 * transport from before 0.9. That person updates; the token does not travel.
 */
export function inviteData(x: { team?: string; dest: { id: string; name: string }; yo: Invite["i"]; k?: string }): Invite {
  return { t: x.team, u: x.dest.id, n: x.dest.name, i: x.yo, k: x.k };
}

export function createInvite(inv: Invite): string {
  return Buffer.from(JSON.stringify(inv)).toString("base64url");
}

/** What gets pasted is never the clean string. It can be the whole command
 *  ("spoochie join eyJ... --email x"), the plugin slash command ("/spoochie:join eyJ..."),
 *  Slack backticks, or the bare chunk. Look for the one token that can be a long
 *  base64url and ignore the rest. */
export function cleanString(input: string): string | null {
  const chunks = (input ?? "").replace(/[`'"]/g, " ").split(/\s+/).filter(Boolean);
  for (const t of chunks) {
    if (t.startsWith("--")) continue;
    if (/^[A-Za-z0-9_-]{40,}$/.test(t)) return t;
  }
  return null;
}

/** An invite is base64url JSON with the inviter's public keys. If it does not decode or
 *  carries no Nostr key, it is not an invite: say so, do not guess. A `b` from an old
 *  version is dropped here and reported: accepting a token that arrives in a pasted
 *  string is exactly what we stopped doing. */
export function readInvite(blob: string): Invite | null {
  try {
    const j = JSON.parse(Buffer.from(blob, "base64url").toString("utf8"));
    const hasNostr = typeof j?.i?.np === "string" && /^[0-9a-f]{64}$/.test(j.i.np);
    if (!hasNostr) return null;
    const inv: Invite = {};
    if (typeof j?.b === "string" && j.b) inv.traiaToken = true;
    if (typeof j.t === "string") inv.t = j.t;
    if (typeof j.u === "string" && /^[UW][A-Z0-9]{6,}$/.test(j.u)) inv.u = j.u;
    // The joiner's name, so they do not sign with their Mac username.
    if (typeof j.n === "string" && j.n.trim()) inv.n = j.n.trim().slice(0, 60);
    // The nonce. It was left out: `readInvite` did not copy it, so `join` sent the hello
    // with `k` undefined and on the other side `redeemInvite` returned null. So a
    // newcomer's hello always landed in "no valid invite and unknown key", and joining
    // over Nostr did not work: you had to add them by hand with --npub, which is the
    // fallback path, not the normal one. Both halves had tests and the seam between them
    // did not.
    if (typeof j.k === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(j.k)) inv.k = j.k;
    if (j.i && typeof j.i.id === "string" && typeof j.i.name === "string") {
      // The name ends up in the contacts, in the notices and in the notice headline.
      // Without a limit, the inviter chooses how much of the accepter's screen it takes.
      inv.i = { id: j.i.id.slice(0, 64), name: j.i.name.trim().slice(0, 60) };
      // The ed25519 key is the base64 of an SPKI: 44 characters. Any string used to get
      // pinned anyway, and from then on every signed envelope from that person came out
      // "mala" without anyone knowing why.
      if (typeof j.i.pk === "string" && /^[A-Za-z0-9+/]{40,100}={0,2}$/.test(j.i.pk)) inv.i.pk = j.i.pk;
      if (hasNostr) inv.i.np = j.i.np;
      if (Array.isArray(j.i.r)) inv.i.r = j.i.r.filter((x: unknown) => typeof x === "string" && /^wss?:\/\//.test(x)).slice(0, 8);
    }
    return inv;
  } catch { return null; }
}

/** The DM the joiner receives. It carries everything they have to do, in order, with the
 *  string already inside: nothing to ask for separately. */
export function inviteText(blob: string, who: string, repo = ORIGIN): string {
  const handle = who.toLowerCase().replace(/\s+/g, "");
  return [
    `${who} invites you to spoochie: a tunnel between your Claude Code session and theirs.`,
    `Nobody writes on your machine and no tunnel opens unless you accept.`,
    `The string below only carries ${who}'s public keys and your Slack id. There is no password inside.`,
    ``,
    `You do not need to install anything first:`,
    `1. In Claude Code:  /plugin marketplace add ${repo}`,
    `2. Then:            /plugin install spoochie@${repo.split("/")[0]}`,
    `3. Restart Claude Code (the first time takes a few seconds: it downloads what it needs).`,
    `4. Paste this into Claude Code, all of it:`,
    `/spoochie:join ${blob}`,
    ``,
    `Your Claude will tell you when you are in. To try it, ask: "open a spoochie with @${handle} and ask them what this is".`,
  ].join("\n");
}
