import { expect, test } from "bun:test";
import { helloDue, forgetHello, HELLO_EVERY_MS } from "../src/hellos.ts";

test("la clave se manda por Slack como mucho una vez al dia por contacto, y lo recuerda entre arranques", () => {
  const t0 = 1_700_000_000_000;
  expect(helloDue("U_UNO", t0)).toBe(true);
  // El mismo arranque, u otro: no se repite hasta pasado un dia.
  expect(helloDue("U_UNO", t0 + 35_000)).toBe(false);
  expect(helloDue("U_UNO", t0 + HELLO_EVERY_MS - 1)).toBe(false);
  expect(helloDue("U_UNO", t0 + HELLO_EVERY_MS)).toBe(true);
  // Otro contacto va por su cuenta.
  expect(helloDue("U_DOS", t0)).toBe(true);
  // Si se olvida (ya tiene clave y la pierde), vuelve a tocar.
  forgetHello("U_UNO");
  expect(helloDue("U_UNO", t0 + HELLO_EVERY_MS + 1)).toBe(true);
});
