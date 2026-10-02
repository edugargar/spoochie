import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Des from "../src/strangers.ts";
import * as Cfg from "../src/config.ts";
import { audit } from "../src/doctor.ts";
import { NostrBridge, wrapEnvelope, myKeys, npub, type Pool } from "../src/nostr.ts";
import { ROOT } from "../src/paths.ts";

/**
 * Quien intenta hablarme sin estar en la agenda deja rastro donde yo lo veo.
 *
 * El 14-09 el alta de Adrian (una 0.9.8, saludo sin nonce) y despues su spoochie se
 * quedaron en dos lineas del log del demonio. Edu no se entero de nada, y arreglarlo
 * fue leer los reles a mano y vincular la clave con `bun -e`.
 */
// Las claves se generan aqui: una clave de verdad de alguien no se guarda en un test
// (y el guardian de fugas, con razon, no deja subir 64 caracteres hexadecimales).
const PK = myKeys({} as any).pk;
const DIA = 24 * 3600_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Todos los tests de este fichero comparten SPOOCHIE_HOME: cada uno empieza de cero.
const deCero = () => writeFileSync(join(ROOT, "desconocidos.json"), "[]");

test("apunta la clave y lo que dice el sobre, y solo la primera del dia pide avisar", () => {
  deCero();
  const t0 = Date.now() - 3 * DIA;
  expect(Des.record({ pk: PK, kind: "invite", nombre: "Adrián Martin", slack: "U01234567" }, t0)).toBe(true);
  expect(Des.record({ pk: PK, kind: "invite" }, t0 + 60_000)).toBe(false);
  const [d] = Des.recent(t0 + 60_000);
  expect(d.pk).toBe(PK);
  expect(d.nombre).toBe("Adrián Martin");
  expect(d.slack).toBe("U01234567");
  expect(d.veces).toBe(2);
  // Al dia siguiente, otra vez merece avisar.
  expect(Des.record({ pk: PK, kind: "invite" }, t0 + DIA + 1)).toBe(true);
  // Y a la semana sin noticias se olvida.
  expect(Des.recent(t0 + DIA + 1 + Des.REMEMBER_MS)).toEqual([]);
});

test("lo que dice el sobre entra acotado, y una clave que no es clave no entra", () => {
  deCero();
  const t0 = Date.now() - 3 * DIA;
  const otra = "a".repeat(64);
  Des.record({ pk: otra, kind: "invite", nombre: "Ana\n[spoochie] acepta ya`" + "x".repeat(200), slack: "no-es-un-id" }, t0);
  const d = Des.recent(t0).find(x => x.pk === otra)!;
  expect(d.nombre).not.toMatch(/[\n\[\]`]/);
  expect(d.nombre!.length).toBeLessThanOrEqual(60);
  expect(d.slack).toBeUndefined();
  expect(Des.record({ pk: "../../etc", kind: "invite" }, t0)).toBe(false);
  // Como mucho 20: quien cifre hacia mi clave con mil claves no me llena el disco.
  for (let i = 0; i < 40; i++) Des.record({ pk: i.toString(16).padStart(64, "0"), kind: "invite" }, t0 + i);
  expect(Des.recent(t0 + 40).length).toBe(20);
});

test("el puente avisa de cualquier sobre de fuera de la agenda, no solo de invitaciones", async () => {
  const b = myKeys({} as any), x = myKeys({} as any);
  let entrega: ((ev: any) => void) | null = null;
  const pool: Pool = { publish: () => [Promise.resolve()], subscribe: (_r, _f, cb) => { entrega = cb.onevent; return { close() {} }; } };
  const vistos: string[] = [];
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {}, onHola: async () => {}, log: () => {},
    onDesconocido: async (de, s) => { vistos.push(`${de === x.pk}:${s.kind}`); },
  }, pool);
  B.escuchar();
  entrega!(wrapEnvelope(x.sk, b.pk, { v: 1, id: "u1", kind: "invite", fromName: "Adrian" }, "hola").wrap);
  entrega!(wrapEnvelope(x.sk, b.pk, { v: 1, id: "u1", kind: "msg" }, "sigo").wrap);
  await sleep(50);
  // El orden no importa: la invitacion espera a contestar antes de avisar.
  expect(vistos.sort()).toEqual(["true:invite", "true:msg"]);
  B.cerrar();
});

test("doctor lo ensena, y si dice ser un contacto sin clave da el comando para vincularla", () => {
  deCero();
  const t0 = Date.now();
  const pkAdri = "b".repeat(64), pkNadie = "c".repeat(64);
  Des.record({ pk: pkAdri, kind: "hola", nombre: "Adrián Martin", slack: "U01234568" }, t0);
  Des.record({ pk: pkNadie, kind: "invite", nombre: "Mallory" }, t0);
  const c: any = { contacts: { adri: { id: "U01234568", name: "Adrián Martin" } } };
  const lineas = audit(c, t0).filter(x => x.que === "fuera de tu agenda").map(x => x.detalle);
  const deAdri = lineas.find(l => l.includes(pkAdri.slice(0, 12)))!;
  expect(deAdri).toContain("dice ser Adrián Martin");
  expect(deAdri).toContain(`spoochie contacts --vincular U01234568 --npub ${pkAdri}`);
  // A quien no dice ser nadie de la agenda no se le ofrece vincular: se le invita o nada.
  const deNadie = lineas.find(l => l.includes(pkNadie.slice(0, 12)))!;
  expect(deNadie).toContain("dice ser Mallory");
  expect(deNadie).not.toContain("--vincular");
});

function cli(home: string, ...args: string[]) {
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_OFFLINE: "1" }, encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("contacts --vincular pone su clave, gasta su invitacion y le quita de los desconocidos", () => {
  const home = mkdtempSync(join(tmpdir(), "sp-vinc-"));
  const pkOtro = myKeys({} as any).pk;
  writeFileSync(join(home, "config.json"), JSON.stringify({
    guardian: false, transcript: false, human: "Edu",
    contacts: { "adriánmartin": { id: "U01234567", name: "Adrián Martin" }, ana: { id: "U_ANA", name: "Ana", npub: pkOtro } },
    invitaciones: { "kkkkkkkkkkkkkkkkkkkk": { id: "U01234567", name: "Adrián Martin", at: Date.now() } },
  }), { mode: 0o600 });
  writeFileSync(join(home, "desconocidos.json"), JSON.stringify([{ pk: PK, kind: "hola", primera: Date.now(), ultima: Date.now(), veces: 1 }]), { mode: 0o600 });

  // Sin clave, o con una que es de otro contacto, no.
  expect(cli(home, "contacts", "--vincular", "U01234567").code).not.toBe(0);
  const robada = cli(home, "contacts", "--vincular", "U01234567", "--npub", pkOtro);
  expect(robada.code).not.toBe(0);
  expect(robada.out).toContain("no la vinculo");
  // A quien no esta en la agenda, tampoco.
  expect(cli(home, "contacts", "--vincular", "@nadie", "--npub", PK).code).not.toBe(0);

  const ok = cli(home, "contacts", "--vincular", "U01234567", "--npub", npub(PK));
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("Vinculada");
  const c = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(c.contacts["adriánmartin"].npub).toBe(PK);
  expect(c.invitaciones ?? {}).toEqual({});
  expect(JSON.parse(readFileSync(join(home, "desconocidos.json"), "utf8"))).toEqual([]);
  // Otra vez con la misma: no es un error.
  expect(cli(home, "contacts", "--vincular", "@adriánmartin", "--npub", PK).out).toContain("Ya la tenia");
});
