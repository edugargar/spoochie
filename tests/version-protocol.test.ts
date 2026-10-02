import { expect, test } from "bun:test";
import { VERSION, versionLine, newerThan } from "../src/version.ts";
import { renderMessage, verdictLabel } from "../src/threads.ts";

test("the version comes from plugin.json and is compared by release line", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(versionLine("0.8.3")).toBe("0.8");
  expect(newerThan("0.8.0", "0.7.9")).toBe(true);
  expect(newerThan("0.7.1", "0.7.1")).toBe(false);
  expect(newerThan("1.0.0", "0.99.99")).toBe(true);
});

test("a message the guardian could not judge is labelled unwatched when rendered", () => {
  // Since 0.9.9 such a message does not even get rendered unless a human releases it
  // (judge returns peligro:true), but when they do, the label shows.
  // "sin vigilar" is the guardian's stored verdict value (guardian.ts); what shows is its label.
  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "B", name: "b", cwd: "/b", human: "Edu" }, context: {}, state: "open", messages: [] };
  const r = renderMessage(t, { at: 1, from: "A", author: "claude", kind: "text", text: "hola", offTopic: { verdict: "sin vigilar", why: "the guardian did not answer in two tries" } } as any, "B");
  expect(r).toContain(verdictLabel("sin vigilar"));
  expect(verdictLabel("sin vigilar")).toContain("not checked");
  expect(r).toContain("did not answer in two tries");
});
