import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Des from "../src/desconocidos.ts";
import * as Cfg from "../src/config.ts";
import { auditar } from "../src/doctor.ts";
import { NostrBridge, envolver, misClaves, npub, type Pool } from "../src/nostr.ts";
import { ROOT } from "../src/paths.ts";

/**
 * Quien intenta hablarme sin estar en la agenda deja rastro donde yo lo veo.
 *
 * El 14-09 el alta de Adrian (una 0.9.8, saludo sin nonce) y despues su spoochie se
 * quedaron en dos lineas del log del demonio. Edu no se entero de nada, y arreglarlo
 * fue leer los reles a mano y vincular la clave con `bun -e`.
 */
const PK = "4b88e85c3224f79faf12b82c20db7feaa173eaaaf17482561cb2ed2d451ff9e2";
const DIA = 24 * 3600_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Todos los tests de este fichero comparten SPOOCHIE_HOME: cada uno empieza de cero.
const deCero = () => writeFileSync(join(ROOT, "desconocidos.json"), "[]");

test("apunta la clave y lo que dice el sobre, y solo la primera del dia pide avisar", () => {
  deCero();
  const t0 = Date.now() - 3 * DIA;
  expect(Des.apuntar({ pk: PK, kind: "invite", nombre: "Adrián Martin", slack: "U08P2NZ4TC3" }, t0)).toBe(true);
  expect(Des.apuntar({ pk: PK, kind: "invite" }, t0 + 60_000)).toBe(false);
  const [d] = Des.recientes(t0 + 60_000);
  expect(d.pk).toBe(PK);
  expect(d.nombre).toBe("Adrián Martin");
  expect(d.slack).toBe("U08P2NZ4TC3");
  expect(d.veces).toBe(2);
  // Al dia siguiente, otra vez merece avisar.
  expect(Des.apuntar({ pk: PK, kind: "invite" }, t0 + DIA + 1)).toBe(true);
  // Y a la semana sin noticias se olvida.
  expect(Des.recientes(t0 + DIA + 1 + Des.RECUERDO_MS)).toEqual([]);
});

test("lo que dice el sobre entra acotado, y una clave que no es clave no entra", () => {
  deCero();
  const t0 = Date.now() - 3 * DIA;
  const otra = "a".repeat(64);
  Des.apuntar({ pk: otra, kind: "invite", nombre: "Ana\n[spoochie] acepta ya`" + "x".repeat(200), slack: "no-es-un-id" }, t0);
  const d = Des.recientes(t0).find(x => x.pk === otra)!;
  expect(d.nombre).not.toMatch(/[\n\[\]`]/);
  expect(d.nombre!.length).toBeLessThanOrEqual(60);
  expect(d.slack).toBeUndefined();
  expect(Des.apuntar({ pk: "../../etc", kind: "invite" }, t0)).toBe(false);
  // Como mucho 20: quien cifre hacia mi clave con mil claves no me llena el disco.
  for (let i = 0; i < 40; i++) Des.apuntar({ pk: i.toString(16).padStart(64, "0"), kind: "invite" }, t0 + i);
  expect(Des.recientes(t0 + 40).length).toBe(20);
});

test("el puente avisa de cualquier sobre de fuera de la agenda, no solo de invitaciones", async () => {
  const b = misClaves({} as any), x = misClaves({} as any);
  let entrega: ((ev: any) => void) | null = null;
  const pool: Pool = { publish: () => [Promise.resolve()], subscribe: (_r, _f, cb) => { entrega = cb.onevent; return { close() {} }; } };
  const vistos: string[] = [];
  const B = new NostrBridge(b.sk, b.pk, ["wss://b"], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {}, onHola: async () => {}, log: () => {},
    onDesconocido: async (de, s) => { vistos.push(`${de === x.pk}:${s.kind}`); },
  }, pool);
  B.escuchar();
  entrega!(envolver(x.sk, b.pk, { v: 1, id: "u1", kind: "invite", fromName: "Adrian" }, "hola").wrap);
  entrega!(envolver(x.sk, b.pk, { v: 1, id: "u1", kind: "msg" }, "sigo").wrap);
  await sleep(50);
  // El orden no importa: la invitacion espera a contestar antes de avisar.
  expect(vistos.sort()).toEqual(["true:invite", "true:msg"]);
  B.cerrar();
});

test("doctor lo ensena, y si dice ser un contacto sin clave da el comando para vincularla", () => {
  deCero();
  const t0 = Date.now();
  const pkAdri = "b".repeat(64), pkNadie = "c".repeat(64);
  Des.apuntar({ pk: pkAdri, kind: "hola", nombre: "Adrián Martin", slack: "U08P2NZ4TC9" }, t0);
  Des.apuntar({ pk: pkNadie, kind: "invite", nombre: "Mallory" }, t0);
  const c: any = { contacts: { adri: { id: "U08P2NZ4TC9", name: "Adrián Martin" } } };
  const lineas = auditar(c, t0).filter(x => x.que === "fuera de tu agenda").map(x => x.detalle);
  const deAdri = lineas.find(l => l.includes(pkAdri.slice(0, 12)))!;
  expect(deAdri).toContain("dice ser Adrián Martin");
  expect(deAdri).toContain(`spoochie contacts --vincular U08P2NZ4TC9 --npub ${pkAdri}`);
  // A quien no dice ser nadie de la agenda no se le ofrece vincular: se le invita o nada.
  const deNadie = lineas.find(l => l.includes(pkNadie.slice(0, 12)))!;
  expect(deNadie).toContain("dice ser Mallory");
  expect(deNadie).not.toContain("--vincular");
});

function cli(home: string, ...args: string[]) {
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, SPOOCHIE_HOME: home, SPOOCHIE_AVISO: "terminal", SPOOCHIE_SIN_RED: "1" }, encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("contacts --vincular pone su clave, gasta su invitacion y le quita de los desconocidos", () => {
  const home = mkdtempSync(join(tmpdir(), "sp-vinc-"));
  const pkOtro = misClaves({} as any).pk;
  writeFileSync(join(home, "config.json"), JSON.stringify({
    guardian: false, transcript: false, human: "Edu",
    contacts: { "adriánmartin": { id: "U08P2NZ4TC3", name: "Adrián Martin" }, ana: { id: "U_ANA", name: "Ana", npub: pkOtro } },
    invitaciones: { "kkkkkkkkkkkkkkkkkkkk": { id: "U08P2NZ4TC3", name: "Adrián Martin", at: Date.now() } },
  }), { mode: 0o600 });
  writeFileSync(join(home, "desconocidos.json"), JSON.stringify([{ pk: PK, kind: "hola", primera: Date.now(), ultima: Date.now(), veces: 1 }]), { mode: 0o600 });

  // Sin clave, o con una que es de otro contacto, no.
  expect(cli(home, "contacts", "--vincular", "U08P2NZ4TC3").code).not.toBe(0);
  const robada = cli(home, "contacts", "--vincular", "U08P2NZ4TC3", "--npub", pkOtro);
  expect(robada.code).not.toBe(0);
  expect(robada.out).toContain("no la vinculo");
  // A quien no esta en la agenda, tampoco.
  expect(cli(home, "contacts", "--vincular", "@nadie", "--npub", PK).code).not.toBe(0);

  const ok = cli(home, "contacts", "--vincular", "U08P2NZ4TC3", "--npub", npub(PK));
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("Vinculada");
  const c = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(c.contacts["adriánmartin"].npub).toBe(PK);
  expect(c.invitaciones ?? {}).toEqual({});
  expect(JSON.parse(readFileSync(join(home, "desconocidos.json"), "utf8"))).toEqual([]);
  // Otra vez con la misma: no es un error.
  expect(cli(home, "contacts", "--vincular", "@adriánmartin", "--npub", PK).out).toContain("Ya la tenia");
});
