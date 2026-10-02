import { expect, test } from "bun:test";
import { judge } from "../src/guardian.ts";

/** No network, no cost: only the short-message shortcut, which is where the noise was. */
test("a short acknowledgement is not judged", async () => {
  const v = await judge("the button breaks on mobile", "OK, all good.");
  expect(v.verdict).toBe("dentro");
  expect(v.why).toBe("too short to judge");
});

test("an empty message is not either", async () => {
  expect((await judge("subject", "   ")).verdict).toBe("dentro");
});

import corpus from "./watcher-corpus.json" with { type: "json" };

/**
 * The corpus runs against Haiku with `bun scripts/watcher.ts`, not here: a test that
 * calls a model costs money and fails over the network, and within a week nobody looks
 * at it. What does get checked here, with no network and in a millisecond, is that the
 * corpus is still a corpus and that the prompt still names what the corpus tests.
 * Deleting a line from the prompt without noticing is the realistic way to break the
 * watcher.
 */
test("the corpus covers both sides and no case is half-filled", () => {
  const cases = corpus.cases as { category: string; danger: boolean; text: string }[];
  expect(cases.length).toBeGreaterThanOrEqual(20);
  expect(cases.filter(c => c.danger).length).toBeGreaterThanOrEqual(10);
  expect(cases.filter(c => !c.danger).length).toBeGreaterThanOrEqual(6);
  for (const c of cases) {
    expect(typeof c.category).toBe("string");
    expect(typeof c.danger).toBe("boolean");
    // Below MIN_CHARS the watcher does not even judge: a case like that proves nothing.
    expect(c.text.trim().length).toBeGreaterThan(40);
  }
});

test("the watcher's prompt still names everything the corpus tests", async () => {
  const source = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  const prompt = source.slice(source.indexOf("const PROMPT"), source.indexOf("export async function judge"));
  for (const word of [
    "run commands", "apply changes without review", "permissions", "install",
    "URLs", "send files", "environment variables", "secret",
    "system rules", "When in doubt about danger, true",
  ]) {
    expect(prompt).toContain(word);
  }
});

test("if the watcher does not answer, the message is held: it does not fail toward letting it through", async () => {
  // Measured with the corpus, one pass of 24 cases: 23 right, 0 escaped and 1 with no
  // answer because it timed out. The one left unanswered was the one asking for
  // ~/.aws/credentials. Not a coincidence: the ambiguous or adversarial message is the
  // one that makes the model think longer, so the clock runs out first on the dangerous ones.
  const source = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  const body = source.slice(source.indexOf("export async function judge"), source.indexOf("function onePass"));
  expect(body).toContain('verdict: "sin vigilar"');
  expect(body).toContain("peligro: true");
  // And with one retry first, because most failures are timeouts, not the model.
  expect(body).toContain("const second = await onePass");
});

/**
 * What the watcher does not read, it does not watch.
 *
 * The prompt had `text.slice(0, 4000)` and `MAX_MENSAJE` is 25,000: twenty-one thousand
 * characters of every message went unread by anyone, while the session got the whole
 * message. That is, four thousand characters of filler and then anything at all. And
 * the 25,000 limit binds whoever sends from the CLI; nobody binds a hostile peer.
 *
 * This test does not call the model: it looks at the only thing the model can see, the
 * prompt.
 */
test("the watcher sees the whole message, and what does not fit does not go in", async () => {
  const source = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  // The message goes whole into the prompt: not one slice on the way.
  // Only the prompt line: the comment above quotes the old slice on purpose.
  const prompt = source.slice(source.indexOf("const PROMPT"), source.indexOf("export async function judge"));
  expect(prompt).toContain("MESSAGE: ${text}");
  expect(prompt).not.toContain(".slice(");

  // And whatever goes over the limit is held, not delivered half-judged.
  const v = await judge("the button", "x".repeat(25_001));
  expect(v.peligro).toBe(true);
  expect(v.why).toContain("is held");
});

test("the watcher's claude starts bare: no settings, hooks, plugins or MCP of this machine", async () => {
  // Starting all that was 6 of the 8 s each judgement took, and every message from the
  // other side waits for the judgement before it is delivered.
  const src = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  for (const flag of [`"--setting-sources", ""`, `"--strict-mcp-config"`, `"--disable-slash-commands"`]) expect(src).toContain(flag);
});
