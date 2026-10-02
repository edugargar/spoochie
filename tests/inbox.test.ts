import { expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver } from "../src/inbox.ts";

/** The inbox format is not in the documentation: it comes from Claude Code's own
 *  binary, which prints it as a supported recipe. If it changes, this test fails. */
test("delivers the auth line and then the user turn, in that order", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "sp-")), "s.sock");
  const lines: string[] = [];
  const done = new Promise<void>(resolve => {
    net.createServer(c => {
      let buf = "";
      c.on("data", d => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
        if (lines.length >= 2) resolve();
      });
    }).listen(sock);
  });

  await deliver(
    { sessionId: "X", name: "x", cwd: "/tmp", socket: sock, token: "tok-123", pid: 1, startedAt: 0 },
    "hello",
  );
  await done;

  expect(JSON.parse(lines[0])).toEqual({ type: "auth", token: "tok-123" });
  expect(JSON.parse(lines[1])).toEqual({ type: "user", message: { role: "user", content: "hello" } });
});

test("a socket that doesn't exist fails instead of hanging", async () => {
  await expect(deliver(
    { sessionId: "X", name: "x", cwd: "/tmp", socket: "/tmp/no-such-spoochie.sock", token: "t", pid: 1, startedAt: 0 },
    "hello",
  )).rejects.toThrow();
});
