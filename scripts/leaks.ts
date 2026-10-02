#!/usr/bin/env bun
/**
 * Leak checker: what must not get into a public repo.
 *
 * Runs in CI on every push and PR, and locally before every push (.githooks/pre-push).
 * It looks at three things: the tree at HEAD, the messages of the new commits, and the
 * author and committer emails of those commits.
 *
 *   bun scripts/leaks.ts [--since <sha>]      (--desde, the old name, still works)
 *
 * What it always looks for: real Slack ids, tokens (Slack, GitHub, AWS, Anthropic,
 * Nostr nsec, private keys), 64-char hex keys, and emails outside a short list of
 * domains. And on top of that the words in SPOOCHIE_FORBIDDEN_WORDS (comma separated,
 * case-insensitive): names of people, of the company, of internal apps. The list does
 * not live in the repo, because that would publish what it wants to hide: in CI it is a
 * GitHub secret, locally a file outside the repo. When one of those words matches, the
 * report says where, not which.
 *
 * Why it exists: the history was rewritten once to remove names and the company, and
 * the same day a commit went out again with the work email. A `git grep` by hand is not
 * a control.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const arg = (...names: string[]) => {
  for (const n of names) { const i = process.argv.indexOf(n); if (i >= 0) return process.argv[i + 1]; }
  return undefined;
};

const ALLOWED_EMAIL_DOMAINS = ["gmail.com", "users.noreply.github.com", "github.com", "anthropic.com", "example.com", "example.org"];
const BINARIES = /\.(png|jpg|jpeg|gif|ico|pdf|woff2?|ttf|lock|zip|gz)$/i;

const PATTERNS: [string, RegExp][] = [
  ["Slack token", /xox[abpe]-[0-9A-Za-z]{8,}-[0-9A-Za-z-]{8,}/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["Nostr nsec", /\bnsec1[a-z0-9]{50,}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["64-char hex key (a real key?)", /\b[0-9a-f]{64}\b/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const forbidden = ((process.env.SPOOCHIE_FORBIDDEN_WORDS ?? process.env.FUGAS_PROHIBIDAS) ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

type Finding = { where: string; what: string };
const findings: Finding[] = [];
const allowedDomain = (domain: string) => ALLOWED_EMAIL_DOMAINS.some(d => domain === d || domain.endsWith("." + d));

function checkText(text: string, where: string, withEmails = true) {
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    for (const [what, re] of PATTERNS) if (re.test(l)) findings.push({ where: `${where}:${i + 1}`, what });
    // A real Slack id mixes letters and digits after the U0; the docs' example is U01234567, digits only.
    for (const m of l.match(/\b[UDCGW]0[0-9A-Z]{7,10}\b/g) ?? []) if (/[A-Z]/.test(m.slice(1))) findings.push({ where: `${where}:${i + 1}`, what: "real Slack id" });
    if (withEmails) for (const m of l.match(EMAIL) ?? []) {
      const domain = m.split("@")[1].toLowerCase();
      if (!allowedDomain(domain)) findings.push({ where: `${where}:${i + 1}`, what: `email outside the list (${domain})` });
    }
    const lower = l.toLowerCase();
    forbidden.forEach((p, n) => { if (lower.includes(p)) findings.push({ where: `${where}:${i + 1}`, what: `forbidden word #${n + 1}` }); });
  });
}

// 1. The tree at HEAD.
for (const f of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (BINARIES.test(f)) continue;
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (text.includes("\0")) continue;
  checkText(text, f);
  forbidden.forEach((p, n) => { if (f.toLowerCase().includes(p)) findings.push({ where: f, what: `forbidden word #${n + 1} in the file name` }); });
}

// 2. The new commits: messages and emails.
const since = arg("--since", "--desde");
const range = since && /^[0-9a-f]{7,40}$/.test(since) && !/^0+$/.test(since) ? `${since}..HEAD` : "HEAD";
let commits: string[] = [];
try { commits = git("rev-list", range).split("\n").filter(Boolean); } catch { commits = [git("rev-parse", "HEAD").trim()]; }
for (const sha of commits) {
  const [ae, ce, ...rest] = git("show", "-s", "--format=%ae%n%ce%n%B", sha).split("\n");
  const body = rest.join("\n");
  for (const [role, email] of [["author", ae], ["committer", ce]]) {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    if (!allowedDomain(domain)) findings.push({ where: `commit ${sha.slice(0, 7)}`, what: `${role} with an email outside the list (${domain || "empty"})` });
  }
  checkText(body, `commit ${sha.slice(0, 7)} (message)`);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
if (findings.length) {
  console.error(`leaks: ${plural(findings.length, "finding")} in ${plural(commits.length, "commit")} and the HEAD tree`);
  for (const h of findings) console.error(`  ${h.where}: ${h.what}`);
  process.exit(1);
}
console.log(`leaks: nothing in ${plural(commits.length, "commit")} or the tree (${plural(forbidden.length, "forbidden word")} on the list)`);
