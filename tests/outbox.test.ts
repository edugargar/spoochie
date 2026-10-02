import { expect, test } from "bun:test";
import * as T from "../src/threads.ts";
import { enqueue } from "../src/outbox.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function thread(id: string): T.Thread {
  const t: T.Thread = {
    id, subject: "test", state: "open", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "A", name: "a", cwd: "/tmp/a" },
    to: { sessionId: "B", name: "b", cwd: "/tmp/b" },
    context: {}, messages: [],
  } as any;
  T.save(t);
  return t;
}

const msg = (text: string, files?: string[]): T.Msg =>
  ({ at: Date.now(), from: "A", author: "claude", kind: "text", text, ...(files ? { files } : {}) });

test("messages in a row go out as one and no attachment is lost", async () => {
  const t = thread("ob01");
  const sent: T.Msg[] = [];
  const send = async (_t: T.Thread, m: T.Msg) => { sent.push(m); };

  enqueue(t, msg("part one", ["/tmp/one.png"]), send, 40);
  enqueue(t, msg("part two", ["/tmp/two.png"]), send, 40);
  enqueue(t, msg("part three", ["/tmp/two.png"]), send, 40);
  await sleep(150);

  expect(sent.length).toBe(1);
  expect(sent[0].text).toBe("part one\n\npart two\n\npart three");
  // The second one's attachment used to vanish, and the repeated one isn't sent twice.
  expect(sent[0].files).toEqual(["/tmp/one.png", "/tmp/two.png"]);
});

test("without attachments it doesn't invent an empty list", async () => {
  const t = thread("ob02");
  const sent: T.Msg[] = [];
  enqueue(t, msg("just text"), async (_t, m) => { sent.push(m); }, 40);
  await sleep(150);
  expect(sent.length).toBe(1);
  expect("files" in sent[0]).toBe(false);
});

test("a patch goes out alone and right away, without waiting for the window", async () => {
  const t = thread("ob03");
  const sent: T.Msg[] = [];
  const send = async (_t: T.Thread, m: T.Msg) => { sent.push(m); };
  enqueue(t, { ...msg("text"), kind: "patch" }, send, 5_000);
  await sleep(30);
  expect(sent.length).toBe(1);
  expect(sent[0].kind).toBe("patch");
});

test("it sends the thread freshly read from disk, not the copy from two seconds ago", async () => {
  const t = thread("ob04");
  const seen: T.Thread[] = [];
  enqueue(t, msg("hello"), async (tt) => { seen.push(tt); }, 60);
  // While it waits for the window, the other side closes the thread.
  T.save({ ...T.load("ob04")!, state: "closed" });
  await sleep(200);
  expect(seen.length).toBe(1);
  expect(seen[0].state).toBe("closed");
});

test("each side has its own window: the voices don't mix", async () => {
  const t = thread("ob05");
  const sent: T.Msg[] = [];
  const send = async (_t: T.Thread, m: T.Msg) => { sent.push(m); };
  enqueue(t, msg("me speaking"), send, 40);
  enqueue(t, { ...msg("me speaking"), from: "B", text: "the other speaking" }, send, 40);
  await sleep(150);
  expect(sent.length).toBe(2);
  expect(sent.map(m => m.text).sort()).toEqual(["me speaking", "the other speaking"]);
});

test("pending messages are written to disk, a new daemon resumes them, and failures are retried", async () => {
  const { enqueue, resume, pending } = await import("../src/outbox.ts");
  const { OUTBOX_FILE } = await import("../src/paths.ts");
  const { existsSync, readFileSync } = await import("node:fs");
  const Tm = await import("../src/threads.ts");
  const t: any = { id: "ob9", subject: "s", state: "open", createdAt: 0, lastActivityAt: 0, context: {}, messages: [],
    from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "slack:U1", name: "b", cwd: "(other)" } };
  Tm.save(t);
  const sent: string[] = [];
  let failing = true;
  const send = async (_t: any, m: any) => { sent.push(m.text); return !failing; };
  enqueue(t, { at: 1, from: "A", author: "claude", kind: "text", text: "one" } as any, send, 30);
  // Before the window passes it is already on disk.
  expect(existsSync(OUTBOX_FILE)).toBe(true);
  expect(readFileSync(OUTBOX_FILE, "utf8")).toContain("one");
  await new Promise(r => setTimeout(r, 120));
  // It went out, failed, and is still recorded with the failure counted.
  expect(sent).toEqual(["one"]);
  expect(pending()).toBe(1);
  expect(JSON.parse(readFileSync(OUTBOX_FILE, "utf8"))[0].fallos).toBe(1);
  // A "new daemon" resumes what's in the file and this time Slack accepts: the file goes away.
  failing = false;
  resume(send);
  await new Promise(r => setTimeout(r, 120));
  expect(sent).toEqual(["one", "one"]);
  expect(pending()).toBe(0);
  expect(existsSync(OUTBOX_FILE)).toBe(false);
});
