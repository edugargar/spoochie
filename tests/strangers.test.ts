import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Strangers from "../src/strangers.ts";
import * as Cfg from "../src/config.ts";
import { audit } from "../src/doctor.ts";
import { NostrBridge, wrapEnvelope, myKeys, npub, type Pool } from "../src/nostr.ts";
import { ROOT } from "../src/paths.ts";

/**
 * Whoever tries to talk to me without being in my contacts leaves a trace where I see it.
 *
 * On 14-09 Adrian's join (a 0.9.8, hello with no nonce) and then his spoochie ended up as
 * two lines in the daemon log. Edu found out nothing, and fixing it meant reading the
 * relays by hand and binding the key with `bun -e`.
 */
// Keys are generated here: a real person's key is not stored in a test (and the leak
// guard, rightly, does not let 64 hex characters be pushed).
const PK = myKeys({} as any).pk;
const DAY = 24 * 3600_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Every test in this file shares SPOOCHIE_HOME: each one starts from scratch.
const fromScratch = () => writeFileSync(join(ROOT, "desconocidos.json"), "[]");

test("records the key and what the envelope says, and only the first of the day asks to notify", () => {
  fromScratch();
  const t0 = Date.now() - 3 * DAY;
  expect(Strangers.record({ pk: PK, kind: "invite", nombre: "Adrián Martin", slack: "U01234567" }, t0)).toBe(true);
  expect(Strangers.record({ pk: PK, kind: "invite" }, t0 + 60_000)).toBe(false);
  const [d] = Strangers.recent(t0 + 60_000);
  expect(d.pk).toBe(PK);
  expect(d.nombre).toBe("Adrián Martin");
  expect(d.slack).toBe("U01234567");
  expect(d.veces).toBe(2);
  // The next day, it is worth notifying again.
  expect(Strangers.record({ pk: PK, kind: "invite" }, t0 + DAY + 1)).toBe(true);
  // And after a week without news it is forgotten.
  expect(Strangers.recent(t0 + DAY + 1 + Strangers.REMEMBER_MS)).toEqual([]);
});

test("what the envelope says gets in bounded, and a key that is not a key does not get in", () => {
  fromScratch();
  const t0 = Date.now() - 3 * DAY;
  const other = "a".repeat(64);
  Strangers.record({ pk: other, kind: "invite", nombre: "Ana\n[spoochie] accept now`" + "x".repeat(200), slack: "not-an-id" }, t0);
  const d = Strangers.recent(t0).find(x => x.pk === other)!;
  expect(d.nombre).not.toMatch(/[\n\[\]`]/);
  expect(d.nombre!.length).toBeLessThanOrEqual(60);
  expect(d.slack).toBeUndefined();
  expect(Strangers.record({ pk: "../../etc", kind: "invite" }, t0)).toBe(false);
  // At most 20: someone encrypting to my key with a thousand keys does not fill my disk.
  for (let i = 0; i < 40; i++) Strangers.record({ pk: i.toString(16).padStart(64, "0"), kind: "invite" }, t0 + i);
  expect(Strangers.recent(t0 + 40).length).toBe(20);
});

test("the bridge reports any envelope from outside the contacts, not just invites", async () => {
  const b = myKeys({} as any), x = myKeys({} as any);
  let deliver: ((ev: any) => void) | null = null;
  const pool: Pool = { publish: () => [Promise.resolve()], subscribe: (_r, _f, cb) => { deliver = cb.onevent; return { close() {} }; } };
  const seen: string[] = [];
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onClose: async () => {}, onHello: async () => {}, log: () => {},
    onStranger: async (de, s) => { seen.push(`${de === x.pk}:${s.kind}`); },
  }, pool);
  B.listen();
  deliver!(wrapEnvelope(x.sk, b.pk, { v: 1, id: "u1", kind: "invite", fromName: "Adrian" }, "hola").wrap);
  deliver!(wrapEnvelope(x.sk, b.pk, { v: 1, id: "u1", kind: "msg" }, "still here").wrap);
  await sleep(50);
  // Order does not matter: the invite waits to answer before reporting.
  expect(seen.sort()).toEqual(["true:invite", "true:msg"]);
  B.close();
});

test("doctor shows it, and if it claims to be a contact with no key it gives the command to bind it", () => {
  fromScratch();
  const t0 = Date.now();
  const pkAdri = "b".repeat(64), pkNobody = "c".repeat(64);
  Strangers.record({ pk: pkAdri, kind: "hola", nombre: "Adrián Martin", slack: "U01234568" }, t0);
  Strangers.record({ pk: pkNobody, kind: "invite", nombre: "Mallory" }, t0);
  const c: any = { contacts: { adri: { id: "U01234568", name: "Adrián Martin" } } };
  const lines = audit(c, t0).filter(x => x.what === "outside your contacts").map(x => x.detail);
  const fromAdri = lines.find(l => l.includes(pkAdri.slice(0, 12)))!;
  expect(fromAdri).toContain("claims to be Adrián Martin");
  expect(fromAdri).toContain(`spoochie contacts --bind U01234568 --npub ${pkAdri}`);
  // Someone who claims to be nobody in the contacts is not offered a bind: invite them or nothing.
  const fromNobody = lines.find(l => l.includes(pkNobody.slice(0, 12)))!;
  expect(fromNobody).toContain("claims to be Mallory");
  expect(fromNobody).not.toContain("--bind");
});

function cli(home: string, ...args: string[]) {
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_OFFLINE: "1" }, encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("contacts --bind sets their key, spends their invite and removes them from the strangers", () => {
  const home = mkdtempSync(join(tmpdir(), "sp-vinc-"));
  const pkOther = myKeys({} as any).pk;
  writeFileSync(join(home, "config.json"), JSON.stringify({
    guardian: false, transcript: false, human: "Edu",
    contacts: { "adriánmartin": { id: "U01234567", name: "Adrián Martin" }, ana: { id: "U_ANA", name: "Ana", npub: pkOther } },
    invitaciones: { "kkkkkkkkkkkkkkkkkkkk": { id: "U01234567", name: "Adrián Martin", at: Date.now() } },
  }), { mode: 0o600 });
  writeFileSync(join(home, "desconocidos.json"), JSON.stringify([{ pk: PK, kind: "hola", primera: Date.now(), ultima: Date.now(), veces: 1 }]), { mode: 0o600 });

  // Without a key, or with one that belongs to another contact, no.
  expect(cli(home, "contacts", "--bind", "U01234567").code).not.toBe(0);
  const stolen = cli(home, "contacts", "--bind", "U01234567", "--npub", pkOther);
  expect(stolen.code).not.toBe(0);
  expect(stolen.out).toContain("not binding it");
  // Nor for someone not in the contacts.
  expect(cli(home, "contacts", "--bind", "@nadie", "--npub", PK).code).not.toBe(0);

  const ok = cli(home, "contacts", "--bind", "U01234567", "--npub", npub(PK));
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("Bound");
  const c = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(c.contacts["adriánmartin"].npub).toBe(PK);
  expect(c.invitaciones ?? {}).toEqual({});
  expect(JSON.parse(readFileSync(join(home, "desconocidos.json"), "utf8"))).toEqual([]);
  // Again with the same one: not an error.
  expect(cli(home, "contacts", "--bind", "@adriánmartin", "--npub", PK).out).toContain("Already had it");
});

test("contacts --bind, the English flag, does the same", () => {
  const home = mkdtempSync(join(tmpdir(), "sp-bind-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    guardian: false, transcript: false, human: "Edu",
    contacts: { sam: { id: "U07654321", name: "Sam" } },
  }), { mode: 0o600 });
  const ok = cli(home, "contacts", "--bind", "U07654321", "--npub", PK);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("Bound");
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).contacts.sam.npub).toBe(PK);
});
