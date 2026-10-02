import { expect, test, afterAll } from "bun:test";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasta, plazo } from "./wait.ts";

/**
 * La primera invitacion crea la clave Nostr, y el demonio ya estaba corriendo sin ella.
 *
 * Visto en la prueba real del 01-10: el demonio de quien invita arranca con la sesion,
 * sin clave; `invite` la crea y la guarda, el demonio no se entera y no escucha a nadie.
 * Quien se daba de alta veia "le he mandado tu clave" y el selftest en verde, y al otro
 * lado no llegaba nada en 4 minutos. Tras un slack-reload a mano, el hola entro en 1 s.
 */
const HOME = mkdtempSync(join(tmpdir(), "sp-inv-"));
const NOSTR = mkdtempSync(join(tmpdir(), "sp-inv-reles-"));
const SRC = join(import.meta.dir, "..", "src");
const env = { ...process.env, SPOOCHIE_HOME: HOME, SPOOCHIE_NOSTR_DIR: NOSTR };
let demonio: ChildProcess | null = null;
afterAll(() => demonio?.kill());

function ping(): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection({ path: join(HOME, "daemon.sock") });
    let buf = "";
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify({ op: "ping" }) + "\n"));
    c.on("data", d => { buf += d.toString(); const i = buf.indexOf("\n"); if (i >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
  });
}

test("tras la primera invitacion, el demonio que ya corria escucha por Nostr", async () => {
  writeFileSync(join(HOME, "config.json"), JSON.stringify({ human: "Ana" }), { mode: 0o600 });
  demonio = spawn("bun", ["run", join(SRC, "daemon.ts")], { env, stdio: "ignore" });
  expect(await hasta(() => existsSync(join(HOME, "daemon.sock")))).toBe(true);
  expect((await ping()).nostr).toBe(false);

  const inv = spawnSync("bun", ["run", join(SRC, "cli.ts"), "invite", "--name", "Bea"], { env, encoding: "utf8" });
  expect(inv.status).toBe(0);
  expect(inv.stdout).toContain("eyJ");

  expect(await hasta(async () => (await ping()).nostr === true, 3000)).toBe(true);
}, plazo(20_000));
