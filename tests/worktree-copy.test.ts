import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeCopy, removeCopy, firstTurn } from "../src/aside.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

test("the aside works on a clean copy of HEAD: committed things are there, local ones are not, and it gets removed", () => {
  const repo = mkdtempSync(join(tmpdir(), "sp-copy-"));
  git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "committed"); git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "one");
  writeFileSync(join(repo, "b.txt"), "not committed");
  writeFileSync(join(repo, ".env"), "SECRET=1");
  const copy = worktreeCopy(repo, "cp1")!;
  expect(copy).toBeTruthy();
  expect(copy).not.toBe(repo);
  expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("committed");
  expect(existsSync(join(copy, "b.txt"))).toBe(false);
  expect(existsSync(join(copy, ".env"))).toBe(false);
  expect(git(repo, "worktree", "list")).toContain(copy);
  // Repeating with the same id does not fail: it gets rebuilt.
  expect(worktreeCopy(repo, "cp1")).toBe(copy);
  removeCopy(repo, copy);
  expect(existsSync(copy)).toBe(false);
  expect(git(repo, "worktree", "list")).not.toContain(copy);
});

test("a directory that is not a repo gets no copy: it is handled in place", () => {
  expect(worktreeCopy(mkdtempSync(join(tmpdir(), "sp-nogit-")), "cp2")).toBeNull();
});

test("the first turn says it is a copy and that uncommitted things are not there", () => {
  const t: any = { id: "z1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "ap", name: "aside", cwd: "/copy", human: "Edu" }, context: {}, state: "open", messages: [] };
  const p = firstTurn(t, "ap", "/x/spoochie", "/copy", "/repo/real");
  expect(p).toContain("CLEAN COPY of /repo/real");
  expect(p).toContain("not committed");
});
