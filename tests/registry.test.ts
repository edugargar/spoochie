import { expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, liveSessions, unregister } from "../src/registry.ts";

const sockOf = (n: string) => { const p = join(mkdtempSync(join(tmpdir(), "sp-")), n); writeFileSync(p, ""); return p; };

test("sweeps the sessions whose process is no longer alive", () => {
  register({ sessionId: "alive", name: "alive", cwd: "/a", socket: sockOf("v.sock"), token: "t", pid: process.pid, startedAt: 1 });
  register({ sessionId: "dead", name: "dead", cwd: "/b", socket: sockOf("m.sock"), token: "t", pid: 999_999, startedAt: 2 });
  const ids = liveSessions().map(s => s.sessionId);
  expect(ids).toContain("alive");
  expect(ids).not.toContain("dead");
  unregister("alive");
});

test("a session without a socket on disk does not count either", () => {
  register({ sessionId: "no-socket", name: "x", cwd: "/c", socket: "/tmp/does-not-exist-x.sock", token: "t", pid: process.pid, startedAt: 3 });
  expect(liveSessions().map(s => s.sessionId)).not.toContain("no-socket");
});

test("an id with slashes does not break registering the session", () => {
  // It really happens: if the SessionStart hook brings no session_id, the socket path is
  // used, and with slashes writeFileSync died with ENOENT without anyone noticing.
  const socket = sockOf("4242.sock");
  register({ sessionId: socket, name: "odd", cwd: "/tmp", socket, token: "t", pid: process.pid, startedAt: Date.now() });
  const found = liveSessions().find(s => s.sessionId === socket);
  expect(found).toBeDefined();
  expect(found!.socket).toBe(socket);
  unregister(socket);
  expect(liveSessions().find(s => s.sessionId === socket)).toBeUndefined();
});
