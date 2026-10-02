import { expect, test } from "bun:test";
import * as T from "../src/threads.ts";
import { SlackBridge } from "../src/slack.ts";

/**
 * The thread cursor used to live in memory: restarting the daemon reread the whole Slack
 * thread and every message already delivered landed in the session again. This
 * simulates that restart with a new bridge over the same thread on disk.
 */
function thread(id: string): T.Thread {
  const t = {
    id, subject: "cursor", state: "open", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "A", name: "a", cwd: "/tmp/a", slackUser: "U_OTRO" },
    to: { sessionId: "B", name: "b", cwd: "/tmp/b", slackUser: "U_ME" },
    context: {}, messages: [],
    slack: { channel: "D1", ts: "100.000" },
  } as any as T.Thread;
  T.save(t);
  return t;
}

function bridge(delivered: T.Msg[]) {
  const b: any = new (SlackBridge as any)(
    "xoxp-fake", "xoxb-fake", "U_ME",
    async (_t: T.Thread, m: T.Msg) => { delivered.push(m); },
    async () => {}, async () => {},
  );
  b.get = async () => ({
    messages: [
      { ts: "100.000", user: "U_OTRO", text: "root" },
      { ts: "101.000", user: "U_OTRO", text: "first" },
      { ts: "102.000", user: "U_OTRO", text: "second" },
    ],
  });
  return b;
}

test("what was already delivered is not delivered again when the daemon restarts", async () => {
  const t = thread("cu01");
  const one: T.Msg[] = [];
  await bridge(one).pollThread(T.load("cu01"));
  expect(one.map(m => m.text)).toEqual(["first", "second"]);
  expect(T.load("cu01")!.slackCursor).toBe("102.000");

  // Restart: new bridge, blank memory, the same Slack thread answering the same.
  const two: T.Msg[] = [];
  await bridge(two).pollThread(T.load("cu01"));
  expect(two).toEqual([]);
});

test("the cursor advances message by message, not all at once at the end", async () => {
  // If something blows up halfway one message is lost, which beats reinjecting the whole thread.
  const t = thread("cu02");
  const seen: T.Msg[] = [];
  const b: any = new (SlackBridge as any)(
    "u", "b", "U_ME",
    async (_t: T.Thread, m: T.Msg) => {
      seen.push(m);
      if (m.text === "second") throw new Error("the session went down");
    },
    async () => {}, async () => {},
  );
  b.get = async () => ({
    messages: [
      { ts: "100.000", user: "U_OTRO", text: "root" },
      { ts: "101.000", user: "U_OTRO", text: "first" },
      { ts: "102.000", user: "U_OTRO", text: "second" },
      { ts: "103.000", user: "U_OTRO", text: "third" },
    ],
  });
  await b.pollThread(T.load("cu02")).catch(() => {});
  expect(seen.map(m => m.text)).toEqual(["first", "second"]);
  expect(T.load("cu02")!.slackCursor).toBe("102.000");
});
