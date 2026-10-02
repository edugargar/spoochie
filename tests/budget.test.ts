import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LENTO, plazo } from "./wait.ts";

/**
 * One knob for a slow machine.
 *
 * `SPOOCHIE_TEST_SLOW` scaled the polls in `hasta()` but not each test's deadline,
 * which is a loose number at the end of the function. The promise was half kept: the
 * waits stretched and the cutoff stayed where it was.
 *
 * Measured with eight processes eating CPU: four tests red, and none because of its
 * logic. The leaks one said `status: null` because bun cut it at the default 5,000 ms,
 * not because the checker failed. With the deadlines multiplied and
 * SPOOCHIE_TEST_SLOW=3, the same load: 250 pass, 0 fail, twice.
 *
 * A test that goes red over a short deadline is worse than no test, because it does
 * not say "this takes longer": it says "this does not pass", and the next thing someone
 * does is stare at good code.
 */
test("no test sets its deadline by hand: all go through the shared budget", () => {
  const dir = import.meta.dir;
  const loose: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    const source = readFileSync(join(dir, f), "utf8");
    for (const [i, line] of source.split("\n").entries()) {
      // A test's deadline is the number that closes the call: `}, 30_000);`
      if (/^\}, *[0-9_]+\);/.test(line)) loose.push(`${f}:${i + 1}  ${line.trim()}`);
    }
  }
  expect(loose).toEqual([]);
});

test("and the budget really multiplies", () => {
  expect(plazo(1000)).toBe(1000 * LENTO);
  expect(LENTO).toBeGreaterThanOrEqual(1);
});

/**
 * The guard above looks at the deadlines a test DECLARES. One that declares none kept
 * bun's 5 s, which SPOOCHIE_TEST_SLOW does not move: measured, `worktree-copy.test.ts`
 * failing at 5,037 ms with the machine loaded. The default deadline is now set by
 * `tests/setup.ts`, the preload of the whole suite.
 */
test("the suite's default deadline also goes through the budget", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const setup = readFileSync(join(import.meta.dir, "setup.ts"), "utf8");
  expect(setup).toContain("setDefaultTimeout(plazo(");
  // And well above bun's 5 s, which is where the ones that start processes fell.
  const base = Number(/setDefaultTimeout\(plazo\(([0-9_]+)\)\)/.exec(setup)?.[1].replace(/_/g, "") ?? 0);
  expect(base).toBeGreaterThanOrEqual(20_000);
});
