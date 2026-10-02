/**
 * The waiting for tests that start real daemons.
 *
 * Each one had its own copy of `hasta()` ("until") with a fixed budget in milliseconds.
 * That works on an idle machine and fails on a loaded one, and the failure does not say
 * "this takes longer", it says "this did not happen": one suite run with another on top
 * gave 2 failures and took 86 s where it normally takes 48. Four runs in parallel, each
 * at 48 s, passed whole. So what breaks is the budget, not the logic.
 *
 * SPOOCHIE_TEST_SLOW multiplies every deadline at once. On a slow machine or a shared
 * CI, `SPOOCHIE_TEST_SLOW=3 bun test` instead of bumping numbers by hand in eight files
 * and forgetting half of them.
 *
 * The exported names (LENTO "slow", dormir "sleep", hasta "until", plazo "deadline")
 * stay in Spanish: every test file imports them.
 */
export const LENTO = Math.max(1, Number(process.env.SPOOCHIE_TEST_SLOW ?? 1) || 1);

export const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Waits for something to be true. Returns whether it was, so it can be asserted. */
export async function hasta(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const limit = ms * LENTO;
  for (let i = 0; i < limit / 50; i++) {
    if (await pred()) return true;
    await dormir(50);
  }
  return await pred();
}

/**
 * A test's deadline, already multiplied.
 *
 * LENTO scaled the waits in `hasta()` but not each test's deadline, which is a loose
 * number at the end of the function. So the promise of "one knob for a slow machine"
 * was half kept: the polls stretched and the cutoff stayed where it was. Measured with
 * eight processes eating CPU: four tests red, and the leaks one said `status: null`
 * because bun cut it at the default 5,000 ms, not because the checker failed.
 *
 * Tests that set no deadline keep bun's 5 s. That is fine for a test that only
 * computes; one that starts processes sets its own with this.
 */
export const plazo = (ms: number) => ms * LENTO;
