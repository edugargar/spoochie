/**
 * How much you trust each contact, and what that changes.
 *
 * Until now the contacts were flat: a contact was an id, a name and some keys, and they
 * all counted the same. Your teammate of three years and someone who joined yesterday got
 * the same treatment, which is too strict for the first and false comfort with the second.
 *
 * What trust DOES change:
 *
 *   level "alto"   the "off topic" labels are not posted in the thread. They are noise
 *                  when the person already knows who they are talking to, and noise ends
 *                  with nobody reading the notices that do matter.
 *   auto <repo>    a spoochie from that person about that repo is accepted without
 *                  showing the dialog. It is standing, scoped consent: per person and per
 *                  repo, never global.
 *
 * What trust does NOT change, and will not: holding back a message that asks to act. The
 * guardian's rule is that the sender need not be trustworthy, and that is precisely
 * because a trusted person's account is the most expensive one when someone takes it
 * over. A trust level that opened that door would turn the contacts into the attack
 * route, the opposite of what they exist for.
 */
import * as Cfg from "./config.ts";

export type Level = "alto" | "normal";

/** The contact behind a sender, whether Slack id or Nostr key. */
export function contactOf(c: Cfg.Config, sender: { slackUser?: string; npub?: string }): { name: string; nivel?: Level; auto?: string[] } | null {
  if (sender.slackUser) {
    const byId = Cfg.contactById(c, sender.slackUser);
    if (byId) return byId as { name: string; nivel?: Level; auto?: string[] };
  }
  if (sender.npub) {
    const byKey = Cfg.contactByNpub(c, sender.npub);
    if (byKey) return byKey as { name: string; nivel?: Level; auto?: string[] };
  }
  return null;
}

export function levelOf(c: Cfg.Config, sender: { slackUser?: string; npub?: string }): Level {
  return contactOf(c, sender)?.nivel === "alto" ? "alto" : "normal";
}

/** A repo's short name: the last chunk of its path. It is what the person types when
 *  giving consent, and what they see in `spoochie contacts`. */
export const repoName = (cwd: string) => cwd.replace(/\/+$/, "").split("/").pop() ?? "";

/**
 * Whether a spoochie from this person about this repo gets in without showing the dialog.
 *
 * Only with both at once. Without a repo there is no consent: a bare "I trust Sam" would
 * be a master key to every machine you work on, and the repo is exactly what limits what
 * the answering Claude can read.
 */
export function autoAccepts(c: Cfg.Config, sender: { slackUser?: string; npub?: string }, cwd: string): boolean {
  const contact = contactOf(c, sender);
  if (!contact?.auto?.length) return false;
  return contact.auto.includes(repoName(cwd));
}

/** Grants or removes a contact's standing consent for a repo. */
export function trust(c: Cfg.Config, name: string, repo: string, remove = false): { ok: false; error: string } | { ok: true; repos: string[] } {
  const key = Cfg.contactKey(name);
  const contact = c.contacts?.[key] as { auto?: string[] } | undefined;
  if (!contact) return { ok: false, error: `"${name}" is not in your contacts` };
  const repos = new Set(contact.auto ?? []);
  if (remove) repos.delete(repo); else repos.add(repo);
  contact.auto = [...repos].sort();
  return { ok: true, repos: contact.auto };
}

export function setLevel(c: Cfg.Config, name: string, level: Level): { ok: false; error: string } | { ok: true } {
  const key = Cfg.contactKey(name);
  const contact = c.contacts?.[key] as { nivel?: Level } | undefined;
  if (!contact) return { ok: false, error: `"${name}" is not in your contacts` };
  if (level === "normal") delete contact.nivel; else contact.nivel = level;
  return { ok: true };
}

/** "4 min ago", "3 h ago", "2 days ago". No decimals: it is a rough guide, not a measurement. */
export function ago(when: number, now = Date.now()): string {
  const min = Math.floor((now - when) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
