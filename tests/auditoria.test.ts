import { expect, test } from "bun:test";
import { auditar } from "../src/doctor.ts";
import type * as Cfg from "../src/config.ts";

const linea = (out: ReturnType<typeof auditar>, que: string) => out.find(x => x.que === que);
const base: Cfg.Config = { guardian: true, transcript: false };

test("una config limpia solo dice que el borrado al cerrar se cumple", () => {
  const out = auditar(base);
  expect(linea(out, "borrado al cerrar")?.ok).toBe(true);
  expect(linea(out, "invitaciones sin canjear")).toBeUndefined();
  expect(linea(out, "contactos sin clave fijada")).toBeUndefined();
  expect(linea(out, "token de bot en reposo")).toBeUndefined();
});

test("cada invitacion sin canjear es un nonce que todavia deja entrar una clave", () => {
  const out = auditar({ ...base, invitaciones: { k1: { name: "Sam", at: Date.now() }, k2: { id: "U0X", at: Date.now() } } });
  const l = linea(out, "invitaciones sin canjear");
  expect(l?.ok).toBe("aviso");
  expect(l?.detalle).toContain("2 viva(s)");
  expect(l?.detalle).toContain("Sam");
});

test("un contacto sin clave fijada se dice: su primera firma sera la que se fije", () => {
  const out = auditar({ ...base, contacts: { sam: { id: "U0S", name: "Sam" }, ana: { id: "U0A", name: "Ana", pk: "PK" } } });
  const l = linea(out, "contactos sin clave fijada");
  expect(l?.detalle).toContain("Sam");
  expect(l?.detalle).not.toContain("Ana");
});

test("el token del bot en reposo se nombra por lo que es: el borde real", () => {
  const out = auditar({ ...base, slack: { userId: "U0", botToken: "xoxb-x", pollMs: 20_000 } });
  const l = linea(out, "token de bot en reposo");
  expect(l?.ok).toBe("aviso");
  expect(l?.detalle).toContain("Rotalo cuando alguien se vaya");
});
