/**
 * Checks the whole loop on this machine, without needing another person.
 *
 * It exists for install day: someone just set up spoochie and wants to know whether it
 * works before writing to a teammate. It brings up two fake inboxes, opens a spoochie
 * from one to the other and goes through the same stops as a real spoochie: the approval
 * gate, the round trip, the close and the notice to the other side.
 *
 * It does NOT touch Slack or your real state: it runs in its own temporary SPOOCHIE_HOME.
 */
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export type Step = { ok: boolean; what: string; detail: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function inbox(name: string) {
  const sock = join(mkdtempSync(join(tmpdir(), `spoochie-st-${name}-`)), "s.sock");
  const received: string[] = [];
  const server = net.createServer(c => {
    let buf = "";
    c.on("data", d => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const f = JSON.parse(line); if (f.type === "user") received.push(f.message.content); } catch {}
      }
    });
    c.on("error", () => {});
  });
  server.listen(sock);
  return { sock, received, server };
}

export async function selftest(): Promise<Step[]> {
  const steps: Step[] = [];
  const home = mkdtempSync(join(tmpdir(), "spoochie-selftest-"));
  const A = inbox("a"), B = inbox("b");
  let daemon: ReturnType<typeof spawn> | null = null;

  const rpc = (req: any): Promise<any> => new Promise((res, rej) => {
    const c = net.createConnection({ path: join(home, "daemon.sock") });
    let buf = "";
    c.setTimeout(10_000, () => { c.destroy(); rej(new Error("the daemon is not answering")); });
    c.on("error", rej);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { c.destroy(); res(JSON.parse(buf.slice(0, i))); } });
  });

  // A step that depends on a broken one does not run: it would say "ok" for the wrong
  // reason, which is worse than a failure because it makes you believe something works.
  const skip = (what: string) => { steps.push({ ok: false, what: what, detail: "never got to test it" }); };

  try {
    const env = { ...process.env, SPOOCHIE_HOME: home };
    // The registry is written by hand: paths.ts fixes its root when it loads, so
    // changing the environment variable halfway through the process does not move it.
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    for (const [id, b, cwd] of [["st-a", A, "/tmp/st-a"], ["st-b", B, "/tmp/st-b"]] as const) {
      writeFileSync(
        join(home, "sessions", `${id}.json`),
        JSON.stringify({ sessionId: id, name: id, cwd, socket: b.sock, token: "t", pid: process.pid, startedAt: Date.now() }),
        { mode: 0o600 },
      );
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: false, human: "selftest" }), { mode: 0o600 });

    const { daemonCommand } = await import("./startup.ts");
    const [cmd, ...args] = daemonCommand();
    daemon = spawn(cmd, args, { env, stdio: "ignore" });
    // Without this listener, a bun that fails to start kills the process with an
    // unhandled error instead of telling you the daemon did not start, which is exactly
    // what you came to find out.
    daemon.on("error", () => {});
    for (let i = 0; i < 60 && !existsSync(join(home, "daemon.sock")); i++) await sleep(100);
    const pong = await rpc({ op: "ping" });
    steps.push({ ok: pong.ok === true, what: "the daemon starts and answers", detail: `pid ${pong.pid}` });

    const opened = await rpc({ op: "open", sessionId: "st-a", to: "st-b", subject: "install check", body: "if you read this, the inbox works" });
    steps.push({ ok: opened.ok && opened.delivered === true, what: "the invite reaches the other inbox", detail: opened.ok ? `spoochie ${opened.id}` : opened.error });
    if (!opened.ok) {
      for (const q of ["the envelope says how to accept", "the gate: no answering before accepting", "only the receiver can accept",
                       "the receiving human opens the tunnel", "round trip", "empty messages are not sent",
                       "closing notifies the other side"]) skip(q);
      return steps;
    }
    const id = opened.id;

    steps.push({
      ok: B.received.some(x => x.includes(`spoochie accept ${id}`)),
      what: "the envelope says how to accept",
      detail: B.received.length ? "the invite carries the command" : "nothing arrived",
    });

    const early = await rpc({ op: "say", sessionId: "st-b", id, text: "answering without permission" });
    steps.push({ ok: early.ok === false, what: "the gate: no answering before accepting", detail: early.ok ? "IT GOT THROUGH" : "rejected, as it should be" });

    const wrong = await rpc({ op: "accept", sessionId: "st-a", id });
    steps.push({ ok: wrong.ok === false, what: "only the receiver can accept", detail: wrong.ok ? "the wrong side accepted" : "rejected" });

    const right = await rpc({ op: "accept", sessionId: "st-b", id });
    steps.push({ ok: right.ok === true, what: "the receiving human opens the tunnel", detail: `state ${right.state}` });

    const reply = await rpc({ op: "say", sessionId: "st-b", id, text: "here is my answer" });
    steps.push({ ok: reply.delivered === true && A.received.some(x => x.includes("here is my answer")), what: "round trip", detail: "the message reaches the other side whole" });

    const empty = await rpc({ op: "say", sessionId: "st-a", id, text: "  " });
    steps.push({ ok: empty.ok === false, what: "empty messages are not sent", detail: empty.ok ? "an empty one went out" : "rejected" });

    // Only what B receives after the close counts, so the check does not hang on the
    // wording of the close notice.
    const beforeClose = B.received.length;
    await rpc({ op: "close", sessionId: "st-a", id, reason: "end of the selftest" });
    steps.push({
      ok: B.received.slice(beforeClose).some(x => x.includes(id)),
      what: "closing notifies the other side",
      detail: "the close notice arrives",
    });

    // "Closing erases" is one of the README's three promises, and it was the only stop
    // in the loop this test did not look at: it closed and took it on faith. On a real
    // machine `doctor` showed FAIL with twelve closed spoochies that still kept the text.
    const path = join(home, "threads", `${id}.json`);
    let left = -1;
    try {
      const t = JSON.parse(readFileSync(path, "utf8"));
      left = (t.messages ?? []).filter((m: { text?: string }) => (m.text ?? "").length > 0).length;
    } catch { left = 0; }
    steps.push({
      ok: left === 0,
      what: "closing erases what was said",
      detail: left === 0 ? "no text left on disk" : `${left} message(s) WITH TEXT LEFT in ${path}`,
    });
  } catch (e) {
    steps.push({ ok: false, what: "the test broke", detail: String(e) });
  } finally {
    daemon?.kill();
    A.server.close(); B.server.close();
  }
  return steps;
}
