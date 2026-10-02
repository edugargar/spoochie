import net from "node:net";
import type { SessionRecord } from "./registry.ts";

/**
 * Deliver a line into a Claude Code session's inbox socket.
 *
 * Wire format is the one Claude Code documents in its own binary:
 *   {"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
 *   {"type":"user","message":{"role":"user","content":"..."}}
 *
 * The auth line is optional on macOS/Linux, but sending the target session's own
 * token is what makes Claude Code verify the message as coming from that session's
 * own child. Without it a bypassPermissions session holds every message for manual
 * approval, which would put a dialog in front of every single turn of a spoochie.
 *
 * Claude Code closes a connection that sends no complete line within its deadline,
 * so we only connect once the text is ready.
 */
export function deliver(target: SessionRecord, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: target.socket });
    const done = (err?: Error) => {
      sock.destroy();
      err ? reject(err) : resolve();
    };
    sock.setTimeout(5000, () => done(new Error(`timeout writing to ${target.socket}`)));
    sock.on("error", done);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "auth", token: target.token }) + "\n");
      sock.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", () => done());
    });
  });
}
