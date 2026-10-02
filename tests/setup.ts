// The tests do not touch your real ~/.claude.
// Careful: os.homedir() in Bun does NOT honor $HOME, so isolating by HOME does not work.
// Isolation goes through SPOOCHIE_HOME, which is what src/paths.ts reads.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SPOOCHIE_HOME = mkdtempSync(join(tmpdir(), "spoochie-test-"));
// And they open no macOS dialogs: the notice goes to the terminal unless a test says otherwise.
process.env.SPOOCHIE_NOTICE ??= "terminal";
// Nor do they check GitHub for a new version, or copy the repo for the aside.
process.env.SPOOCHIE_OFFLINE = "1";

/**
 * The tests' default deadline, and why it is not bun's 5 s.
 *
 * Many tests here start real processes: daemons, git, osascript. With the machine
 * loaded, five seconds is not enough. Measured: `worktree-copy.test.ts` failed at
 * 5,037 ms, right at the cutoff, and the message did not say "this takes longer", it
 * said "this does not pass".
 *
 * The deadlines each test declares already went through `plazo()`, but a test that
 * declares none kept bun's 5 s, and SPOOCHIE_TEST_SLOW did not move those. So the
 * slow-machine knob still did not reach everything.
 */
import { setDefaultTimeout } from "bun:test";
import { plazo } from "./wait.ts";
setDefaultTimeout(plazo(20_000));
