import { expect, test } from "bun:test";
import { judgeTurn } from "../src/sentinel.ts";

const thread = (msgs: any[], state = "open"): any => ({
  id: "c1", subject: "s", state,
  from: { sessionId: "THEM", name: "ana", cwd: "/a", human: "Ana" },
  to: { sessionId: "ME", name: "me", cwd: "/b", human: "Edu" },
  context: {}, messages: msgs,
});
const msg = (from: string, x: any = {}) => ({ at: 1, from, author: "claude", kind: "text", text: "x", ...x });

test("if the last message is from the other side, it can't go quiet", () => {
  const d = judgeTurn(thread([msg("THEM")]), "ME", false);
  expect(d.decision).toBe("block");
  expect(d.reason).toContain("spoochie say c1");
  expect(d.reason).toContain("spoochie close c1");
});

test("if it already answered, it goes quiet in peace", () => {
  expect(judgeTurn(thread([msg("THEM"), msg("ME")]), "ME", false).decision).toBeUndefined();
});

test("a message held by the watcher isn't waiting for an answer: it waits for its human", () => {
  const t = thread([msg("THEM"), msg("ME"), msg("THEM", { retenido: "si" })]);
  expect(judgeTurn(t, "ME", false).decision).toBeUndefined();
  const discarded = thread([msg("THEM"), msg("ME"), msg("THEM", { retenido: "descartado" })]);
  expect(judgeTurn(discarded, "ME", false).decision).toBeUndefined();
});

test("it doesn't block twice in a row: an aside stuck in a loop is worse than a quiet one", () => {
  expect(judgeTurn(thread([msg("THEM")]), "ME", true).decision).toBeUndefined();
});

test("a closed or missing thread blocks nothing", () => {
  expect(judgeTurn(thread([msg("THEM")], "closed"), "ME", false).decision).toBeUndefined();
  expect(judgeTurn(thread([msg("THEM")], "pending"), "ME", false).decision).toBeUndefined();
  expect(judgeTurn(null, "ME", false).decision).toBeUndefined();
});

test("a thread with no messages yet claims nothing", () => {
  expect(judgeTurn(thread([]), "ME", false).decision).toBeUndefined();
});

/**
 * The unread notice, the only proactivity spoochie allows itself:
 * facts about the thread, never initiative about the work. The conditions are in
 * `warnUnread` (daemon.ts) and here we test the logic that decides them.
 */
import { readFileSync } from "node:fs";

test("the unread notice only comes from a tunnel that got opened", async () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  const f = source.slice(source.indexOf("async function warnUnread"), source.indexOf("async function tick"));
  // If you rejected it, reminding you of the message you rejected is the opposite of
  // respecting the decision.
  expect(f).toContain("if (!t.acceptedAt) return;");
  // If we answered last, nothing is pending.
  expect(f).toContain("if (last.from === mine) return;");
  // If you closed it, closing was your answer: you've seen it.
  expect(f).toContain("if (closedBy === mine) return;");
  expect(source).toContain("await warnUnread(t, bySession);");
  // If the aside is still alive, it has seen it.
  expect(f).toContain("if (ap && !ap.dead");
  // And what it says is facts: who, when, the text and where the whole thread is.
  expect(f).toContain("with no reply from you");
  expect(f).toContain("don't open another spoochie on your own");
});

test("whoever opens knows the answer arrives on its own and doesn't wait for it in the foreground", () => {
  // 01-10 real test: a foreground loop of `spoochie show` + sleep left Bea's
  // answer in the inbox for 4 min 28 s, unable to come in as a turn.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const open = cli.slice(cli.indexOf('case "open": {'), cli.indexOf('case "take":'));
  expect(open).toContain("console.log(`\\n${HOW_TO_WAIT}`)");
  expect(cli).toContain("Now end your turn. The answer will reach you on its own");
  const skill = readFileSync(new URL("../commands/spoochie.md", import.meta.url), "utf8");
  expect(skill).toContain("After opening, end your turn.");
  expect(skill).toContain("Do not wait for it with `spoochie show`, sleep, loops or Monitor");
});
