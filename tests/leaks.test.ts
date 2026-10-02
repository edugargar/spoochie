import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plazo } from "./wait.ts";

/** A test repo with the checker inside, so `git ls-files` sees it as in the real one. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "sp-leaks-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_COMMITTER_NAME: "x" } });
  git("init", "-q");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(import.meta.dir, "..", "scripts", "leaks.ts"), join(dir, "scripts", "leaks.ts"));
  const commit = (msg: string, email: string) => { git("add", "-A"); git("-c", `user.email=${email}`, "-c", "user.name=x", "commit", "-q", "-m", msg); };
  const run = (list = "", since?: string, flag = "--since") => spawnSync("bun", ["scripts/leaks.ts", ...(since ? [flag, since] : [])], { cwd: dir, encoding: "utf8", env: { ...process.env, SPOOCHIE_FORBIDDEN_WORDS: list } });
  return { dir, git, commit, run };
}

test("the leak checker lets a clean repo through and stops one with ids, tokens, emails or forbidden words", () => {
  const r = repo();
  writeFileSync(join(r.dir, "README.md"), "spoochie invite --to sam@example.com  # or --to U01234567\nnpub keys are fine: " + "npub1" + "x".repeat(58) + "\n");
  r.commit("Clean", "me@gmail.com");
  const ok = r.run("acme,lopez");
  expect(ok.stdout + ok.stderr).toContain("nothing in 1 commit");
  expect(ok.status).toBe(0);

  // Everything that must not get in, in a file, a file name, a message and an author email.
  writeFileSync(join(r.dir, "notes.md"), [
    // The test data is built in pieces: the checker itself reads this file.
    "Ana's id is U0" + "9ABCDE7XYZ",
    "token xoxb-" + "1234567890-ABCDEFGHIJKLMN-abcdefghijklmnop",
    "key " + "0123456789abcdef".repeat(4),
    "write to ana@" + "acme-corp.com",
    "Lopez said it in the meeting",
  ].join("\n"));
  writeFileSync(join(r.dir, "for-lopez.md"), "hi\n");
  r.commit("Notes from the meeting with ACME", "me@" + "acme-corp.com");
  const base = r.git("rev-parse", "HEAD~1").trim();
  const bad = r.run("acme,lopez", base);
  expect(bad.status).toBe(1);
  const out = bad.stderr;
  expect(out).toContain("notes.md:1: real Slack id");
  expect(out).toContain("notes.md:2: Slack token");
  expect(out).toContain("notes.md:3: 64-char hex key");
  expect(out).toContain("notes.md:4: email outside the list (acme-corp.com)");
  expect(out).toContain("notes.md:4: forbidden word #1");
  expect(out).toContain("notes.md:5: forbidden word #2");
  expect(out).toContain("for-lopez.md: forbidden word #2 in the file name");
  expect(out).toMatch(/commit [0-9a-f]{7} \(message\):1: forbidden word #1/);
  expect(out).toMatch(/commit [0-9a-f]{7}: author with an email outside the list \(acme-corp.com\)/);
  // The report never writes the forbidden word.
  expect(out.toLowerCase()).not.toContain("lopez.md: forbidden word #2 in the file name: lopez");
  expect(out).not.toContain("acme,lopez");

  // --desde, the old name of --since, still works: .githooks/pre-push and CI used it.
  const old = r.run("acme,lopez", base, "--desde");
  expect(old.status).toBe(1);
  expect(old.stderr).toBe(out);
}, plazo(20_000));
