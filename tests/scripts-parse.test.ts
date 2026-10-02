import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The scripts are not imported by any test, so a syntax error in one only shows when
 * someone runs it. One reached the real test, which is the gate before every push.
 */
const DIR = join(import.meta.dir, "..", "scripts");
for (const f of readdirSync(DIR).filter(f => f.endsWith(".ts"))) {
  test(`scripts/${f} parses`, async () => {
    const r = await Bun.build({ entrypoints: [join(DIR, f)], target: "bun", throw: false });
    expect(r.logs.filter(l => l.level === "error").map(l => l.message)).toEqual([]);
  });
}
