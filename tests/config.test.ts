import { expect, test } from "bun:test";
import { plazo } from "./wait.ts";

test("a contact name already taken by another id is not overwritten: it gets a suffix", async () => {
  const Cfg = await import("../src/config.ts");
  const c: any = { guardian: false, transcript: false, contacts: {} };
  Cfg.addContact(c, { id: "U_EDU_REAL", name: "Edu", pk: "pk-real" });
  Cfg.addContact(c, { id: "U_IMPOSTOR", name: "Edu", pk: "pk-otro" });
  expect(Cfg.contact(c, "edu")!.id).toBe("U_EDU_REAL");
  expect(Cfg.contact(c, "edu")!.pk).toBe("pk-real");
  expect(Cfg.contactById(c, "U_IMPOSTOR")!.name).toBe("Edu");
  expect(Object.keys(c.contacts)).toContain("edu-stor");
  // The same id with another name does get renamed, without duplicating.
  Cfg.addContact(c, { id: "U_EDU_REAL", name: "Eduardo" });
  expect(Cfg.contact(c, "eduardo")!.pk).toBe("pk-real");
  expect(Cfg.contact(c, "edu")).toBeNull();
});

/**
 * The worst thing in here needs no attacker: dying halfway through a write is enough.
 *
 * `save` used to truncate and write, so a SIGKILL, a power cut or the OOM killer left the
 * file half written. Probe: with the file cut in half, `load` returned the default config
 * without a word (signing key: none, contacts: empty) and the next `save` wrote over it.
 * The signing key, the Nostr key, the bot token and every contact were lost, silently and
 * for good.
 */
test("a half-written config does not take your keys or your contacts with it", async () => {
  const Cfg = await import("../src/config.ts");
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ROOT } = await import("../src/paths.ts");
  const F = join(ROOT, "config.json");

  const c = Cfg.load();
  c.human = "Edu";
  c.keys = { pub: "PUB", priv: "PRIV-DE-FIRMA" } as any;
  Cfg.addContact(c, { id: "U_ATOM", name: "Sam", pk: "PK-DE-SAM" } as any);
  Cfg.save(c);
  Cfg.save(Cfg.load());            // a second one so the backup exists

  // What a process killed halfway through a write leaves behind.
  const whole = readFileSync(F, "utf8");
  writeFileSync(F, whole.slice(0, Math.floor(whole.length / 2)));

  const d = Cfg.load();
  expect(d.human).toBe("Edu");
  expect(d.keys?.priv).toBe("PRIV-DE-FIRMA");
  expect(Cfg.contactById(d, "U_ATOM")?.name).toBe("Sam");
  expect(Cfg.unreadableConfig()).toBe(false);

  // And if there is no backup either, it says so and does NOT write over it: turning
  // "cannot read it" into "it does not exist" is losing the three keys for good.
  writeFileSync(`${F}.bak`, "{ this one neither");
  const e = Cfg.load();
  expect(Cfg.unreadableConfig()).toBe(true);
  const before = readFileSync(F, "utf8");
  Cfg.save(e);
  expect(readFileSync(F, "utf8")).toBe(before);
  expect(existsSync(`${F}.nuevo`)).toBe(false);

  // Put it back as it was for the other tests in the file.
  writeFileSync(F, whole);
  Cfg.forgetBroken();
  expect(Cfg.load().human).toBe("Edu");
});

/**
 * Two processes saving the config at once.
 *
 * The daemon records a contact on every incoming message (`touchContact`) and pins keys;
 * the CLI writes in `join`, `contacts`, `trust`, `rotate` and `forget`. Both do
 * read-modify-save on the whole file, so the last one to save erased the other's work.
 * Measured with two real processes: only one of the two contacts was left, so a freshly
 * pinned key (or your own, just created by `join`) disappeared without a word.
 *
 * It has to be two processes: inside one, both `load` calls share the same state and the
 * race does not exist.
 */
test("two processes saving at once do not erase each other's contact", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "sp-carrera-"));
  const root = join(import.meta.dir, "..");
  const script = join(home, "uno.ts");
  writeFileSync(script, `
const Cfg = await import(${JSON.stringify(join(root, "src", "config.ts"))});
const c = Cfg.load();
await new Promise(r => setTimeout(r, Number(process.env.WAIT_MS)));
Cfg.addContact(c, { id: process.env.ID, name: process.env.NAME, pk: "PK-" + process.env.NAME });
Cfg.save(c);
`);
  const env = { ...process.env, SPOOCHIE_HOME: home };
  Bun.spawnSync(["bun", "-e", `const C = await import(${JSON.stringify(join(root, "src", "config.ts"))}); const c = C.load(); c.human = "Edu"; C.save(c);`], { env, cwd: root });

  // A reads, B reads, B saves, A saves on top: the case that lost B.
  const a = Bun.spawn(["bun", "run", script], { env: { ...env, ID: "U_CA", NAME: "Ana", WAIT_MS: "400" }, cwd: root });
  const b = Bun.spawn(["bun", "run", script], { env: { ...env, ID: "U_CB", NAME: "Bea", WAIT_MS: "200" }, cwd: root });
  await Promise.all([a.exited, b.exited]);

  const end = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(Object.keys(end.contacts ?? {}).sort()).toEqual(["ana", "bea"]);
  // And neither key got lost on the way.
  expect(end.contacts.ana.pk).toBe("PK-Ana");
  expect(end.contacts.bea.pk).toBe("PK-Bea");
}, plazo(20_000));

/**
 * What is kept is what appeared while we had our copy in hand, not everything on disk:
 * otherwise `spoochie forget` would never forget.
 */
test("forget still forgets even if another process wrote in between", async () => {
  const Cfg = await import("../src/config.ts");
  const c = Cfg.load();
  Cfg.addContact(c, { id: "U_OLV", name: "Olvidable", pk: "PK" } as any);
  Cfg.save(c);

  const d = Cfg.load();
  delete d.contacts!["olvidable"];
  Cfg.save(d);
  expect(Cfg.contactById(Cfg.load(), "U_OLV")).toBeNull();
});
