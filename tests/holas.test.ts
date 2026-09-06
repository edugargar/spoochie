import { expect, test } from "bun:test";
import { tocaHola, olvidarHola, HOLA_CADA_MS } from "../src/holas.ts";

test("la clave se manda por Slack como mucho una vez al dia por contacto, y lo recuerda entre arranques", () => {
  const t0 = 1_700_000_000_000;
  expect(tocaHola("U_UNO", t0)).toBe(true);
  // El mismo arranque, u otro: no se repite hasta pasado un dia.
  expect(tocaHola("U_UNO", t0 + 35_000)).toBe(false);
  expect(tocaHola("U_UNO", t0 + HOLA_CADA_MS - 1)).toBe(false);
  expect(tocaHola("U_UNO", t0 + HOLA_CADA_MS)).toBe(true);
  // Otro contacto va por su cuenta.
  expect(tocaHola("U_DOS", t0)).toBe(true);
  // Si se olvida (ya tiene clave y la pierde), vuelve a tocar.
  olvidarHola("U_UNO");
  expect(tocaHola("U_UNO", t0 + HOLA_CADA_MS + 1)).toBe(true);
});
