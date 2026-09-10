import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("enmascarar pregunta al llavero en vez de recordar un estado", () => {
  // Sin esto la migracion se deshacia sola: `load` rellena el secreto de verdad y
  // cualquier `save` posterior (hay uno en casi cada operacion) lo volvia a escribir en
  // claro. Se decide preguntando: si el llavero tiene la clave, en el fichero va la senal.
  const fuente = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const f = fuente.slice(fuente.indexOf("export function enmascarar"), fuente.indexOf("export function tocarContacto"));
  expect(f).toContain("L.leer(L.CUENTAS.firma)");
  expect(f).toContain("L.leer(L.CUENTAS.nostr)");
  expect(f).toContain("L.leer(L.CUENTAS.bot)");
  // Y `save` pasa siempre por ahi, no solo cuando alguien se acuerda.
  expect(fuente).toContain("JSON.stringify(enmascarar(c), null, 2)");
});

test("si el llavero no contesta se deja la senal, no se firma con ella", () => {
  const fuente = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const f = fuente.slice(fuente.indexOf("export function rellenarDelLlavero"), fuente.indexOf("export function alLlavero"));
  // El patron es `const v = L.leer(...); if (v)`: sin valor no se toca nada, asi que
  // spoochie dice "no tengo clave" en vez de firmar con la cadena "@llavero" y que el
  // otro lado descarte los sobres sin saber por que.
  expect(f).toContain("if (v)");
  expect(f).not.toContain("?? L.SENAL");
});

test("los tres secretos que se mueven son los tres que hay", () => {
  const { CUENTAS } = require("../src/llavero.ts");
  expect(Object.keys(CUENTAS).sort()).toEqual(["bot", "firma", "nostr"]);
  const cfg = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  // La privada ed25519, la secreta de Nostr y el token del bot. Si aparece un cuarto
  // secreto en la config, este test no lo sabe: por eso estan nombrados aqui.
  expect(cfg).toContain("keys?: { pub: string; priv: string }");
  expect(cfg).toContain("nostr?: { sk?: string");
  expect(cfg).toContain("botToken?: string");
});
