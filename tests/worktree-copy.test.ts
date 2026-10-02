import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeCopy, removeCopy, firstTurn } from "../src/aside.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

test("el aparte trabaja sobre una copia limpia de HEAD: lo commiteado esta, lo local no, y se retira", () => {
  const repo = mkdtempSync(join(tmpdir(), "sp-copia-"));
  git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "commiteado"); git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "uno");
  writeFileSync(join(repo, "b.txt"), "sin commit");
  writeFileSync(join(repo, ".env"), "SECRETO=1");
  const copia = worktreeCopy(repo, "cp1")!;
  expect(copia).toBeTruthy();
  expect(copia).not.toBe(repo);
  expect(readFileSync(join(copia, "a.txt"), "utf8")).toBe("commiteado");
  expect(existsSync(join(copia, "b.txt"))).toBe(false);
  expect(existsSync(join(copia, ".env"))).toBe(false);
  expect(git(repo, "worktree", "list")).toContain(copia);
  // Repetir con el mismo id no falla: se rehace.
  expect(worktreeCopy(repo, "cp1")).toBe(copia);
  removeCopy(repo, copia);
  expect(existsSync(copia)).toBe(false);
  expect(git(repo, "worktree", "list")).not.toContain(copia);
});

test("un directorio que no es un repo no tiene copia: se atiende en el sitio", () => {
  expect(worktreeCopy(mkdtempSync(join(tmpdir(), "sp-nogit-")), "cp2")).toBeNull();
});

test("el primer turno dice que es una copia y que lo no commiteado no esta", () => {
  const t: any = { id: "z1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "ap", name: "aparte", cwd: "/copia", human: "Edu" }, context: {}, state: "open", messages: [] };
  const p = firstTurn(t, "ap", "/x/spoochie", "/copia", "/repo/real");
  expect(p).toContain("COPIA LIMPIA de /repo/real");
  expect(p).toContain("no este commiteado");
});
