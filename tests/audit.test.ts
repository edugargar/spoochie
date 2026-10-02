import { expect, test } from "bun:test";
import { audit } from "../src/doctor.ts";
import type * as Cfg from "../src/config.ts";

const linea = (out: ReturnType<typeof audit>, que: string) => out.find(x => x.que === que);
const base: Cfg.Config = { guardian: true, transcript: false };

test("una config limpia solo dice que el borrado al cerrar se cumple", () => {
  const out = audit(base);
  expect(linea(out, "borrado al cerrar")?.ok).toBe(true);
  expect(linea(out, "invitaciones sin canjear")).toBeUndefined();
  expect(linea(out, "contactos sin clave fijada")).toBeUndefined();
  expect(linea(out, "token de bot en reposo")).toBeUndefined();
});

test("cada invitacion sin canjear es un nonce que todavia deja entrar una clave", () => {
  const out = audit({ ...base, invitaciones: { k1: { name: "Sam", at: Date.now() }, k2: { id: "U0X", at: Date.now() } } });
  const l = linea(out, "invitaciones sin canjear");
  expect(l?.ok).toBe("aviso");
  expect(l?.detalle).toContain("2 viva(s)");
  expect(l?.detalle).toContain("Sam");
});

test("un contacto sin clave fijada se dice: su primera firma sera la que se fije", () => {
  const out = audit({ ...base, contacts: { sam: { id: "U0S", name: "Sam" }, ana: { id: "U0A", name: "Ana", pk: "PK" } } });
  const l = linea(out, "contactos sin clave fijada");
  expect(l?.detalle).toContain("Sam");
  expect(l?.detalle).not.toContain("Ana");
});

test("el token del bot en reposo se nombra por lo que es: el borde real", () => {
  const out = audit({ ...base, slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = linea(out, "token de bot en reposo");
  expect(l?.ok).toBe("aviso");
  expect(l?.detalle).toContain("Rotalo cuando alguien se vaya");
});

import { lastStart } from "../src/doctor.ts";

test("el ultimo arranque del hook se lee de disco, incluido cuando fallo", () => {
  expect(lastStart(null)).toBeNull();
  expect(lastStart("   ")).toBeNull();
  const ok = lastStart("2026-09-10T12:00:00Z\tok\tsesion registrada con spoochie 0.9.9");
  expect(ok?.ok).toBe(true);
  expect(ok?.detalle).toContain("0.9.9");
  // Un fallo no es un aviso: sin binario no llega ni un spoochie, y la sesion donde se
  // imprimio el error puede haberse cerrado hace dias.
  const mal = lastStart("2026-09-10T12:00:00Z\tfallo\tel binario no cuadra con el SHA256SUMS");
  expect(mal?.ok).toBe(false);
  expect(mal?.detalle).toContain("SHA256SUMS");
  expect(mal?.detalle).toContain("2026-09-10T12:00:00Z");
});

test("doctor dice cuales de los tres secretos siguen en claro en el fichero", () => {
  const enClaro = audit({ ...base, keys: { pub: "P", priv: "SECRETA" }, nostr: { sk: "aaa", pk: "bbb" }, slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = linea(enClaro, "secretos en config.json");
  expect(l?.detalle).toContain("clave de firma");
  expect(l?.detalle).toContain("clave Nostr");
  expect(l?.detalle).toContain("token del bot");
  expect(l?.detalle).toContain("spoochie llavero on");
  // Los que ya estan en el llavero no se cuentan.
  const enLlavero = audit({ ...base, keys: { pub: "P", priv: "@llavero" }, nostr: { sk: "@llavero", pk: "bbb" } });
  expect(linea(enLlavero, "secretos en config.json")).toBeUndefined();
});

test("si todos tus contactos tienen clave Nostr, doctor dice que ya no necesitas el token", () => {
  const todos = audit({ ...base,
    contacts: { sam: { id: "U_S", name: "Sam", npub: "a".repeat(64) }, ana: { id: "U_A", name: "Ana", npub: "b".repeat(64) } },
    slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = linea(todos, "ya no necesitas el token del bot");
  expect(l?.detalle).toContain("2 contacto(s)");
  expect(l?.detalle).toContain("spoochie slack off");
  // Con uno solo sin clave, no: ese seguiria necesitando Slack.
  const mixto = audit({ ...base,
    contacts: { sam: { id: "U_S", name: "Sam", npub: "a".repeat(64) }, ana: { id: "U_A", name: "Ana" } },
    slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  expect(linea(mixto, "ya no necesitas el token del bot")).toBeUndefined();
});
