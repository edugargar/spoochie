import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * The first invite creates the Nostr key, and the daemon was already running without it.
 *
 * Seen in the 01-10 real test: the inviter's daemon starts with the session,
 * with no key; `invite` creates and stores it, the daemon doesn't notice and listens to nobody.
 * Whoever joined saw "I've sent them your key" and the selftest green, and nothing reached
 * the other side in 4 minutes. After a manual slack-reload, the hello came in within 1 s.
 */
const HOME = mkdtempSync(join(tmpdir(), "sp-inv-"));
const NOSTR = mkdtempSync(join(tmpdir(), "sp-inv-relays-"));
const SRC = join(import.meta.dir, "..", "src");
const env = { ...process.env, SPOOCHIE_HOME: HOME, SPOOCHIE_NOSTR_DIR: NOSTR };
let daemon: ChildProcess | null = null;
afterAll(() => daemon?.kill());

function ping(): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection({ path: join(HOME, "daemon.sock") });
    let buf = "";
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify({ op: "ping" }) + "\n"));
    c.on("data", d => { buf += d.toString(); const i = buf.indexOf("\n"); if (i >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
  });
}

test("after the first invite, the daemon that was already running listens on Nostr", async () => {
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ human: "Ana" }), { mode: 0o600 });
  daemon = spawn("bun", ["run", join(SRC, "daemon.ts")], { env, stdio: "ignore" });
  expect(await hasta(() => existsSync(join(HOME, "daemon.sock")))).toBe(true);
  expect((await ping()).nostr).toBe(false);

  const inv = spawnSync("bun", ["run", join(SRC, "cli.ts"), "invite", "--name", "Bea"], { env, encoding: "utf8" });
  expect(inv.status).toBe(0);
  expect(inv.stdout).toContain("eyJ");

  expect(await hasta(async () => (await ping()).nostr === true, 3000)).toBe(true);
}, plazo(20_000));
