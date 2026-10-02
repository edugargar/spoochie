import { expect, test } from "bun:test";
import { selftest } from "../src/selftest.ts";
import { plazo } from "./wait.ts";

/**
 * A step that is green because it never ran is worse than a failure: it makes you
 * believe something works. Here the very first thing breaks (the daemon starting) and
 * the test checks that nothing after it comes out green.
 */
test("with the daemon broken, not a single step comes out green", async () => {
  // PATH is not broken: Bun resolves "bun" to itself even when it is not on PATH, and
  // that made this test pass or fail depending on the suite order.
  process.env.SPOOCHIE_DAEMON_CMD = "/nonexistent/bun run daemon.ts";
  try {
    const steps = await selftest();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter(p => p.ok)).toEqual([]);
    expect(steps.some(p => p.detail === "never got to test it" || p.what === "the test broke")).toBe(true);
  } finally {
    delete process.env.SPOOCHIE_DAEMON_CMD;
  }
}, plazo(30_000));
