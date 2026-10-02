import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The SessionStart hook downloads its own binary and prunes the rest. It used to delete
 * every other version, newer ones included: an aside window opened by a 0.9.10 daemon
 * ran the installed 0.9.9 hook, which deleted spoochie-0.9.10, and the aside's
 * gatekeeper hook then pointed at nothing.
 */
test("only binaries older than the hook's own version are deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-prune-"));
  for (const n of ["spoochie-0.9.8", "spoochie-0.9.9", "spoochie-0.9.10", "spoochie-0.10.0", "spoochie", "spoochie-0.9.9.tmp"]) writeFileSync(join(dir, n), "");
  const r = spawnSync("sh", [join(import.meta.dir, "..", "hooks", "prune-binaries.sh"), dir, "0.9.9"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(readdirSync(dir).sort()).toEqual(["spoochie-0.10.0", "spoochie-0.9.10", "spoochie-0.9.9", "spoochie-0.9.9.tmp"]);
});
