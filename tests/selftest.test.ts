import { expect, test } from "bun:test";
import { selftest } from "../src/selftest.ts";
import { plazo } from "./wait.ts";

/**
 * Un paso en verde porque nunca llego a ejecutarse es peor que un fallo: te hace
 * creer que algo funciona. Aqui se rompe lo primero de todo (que arranque el
 * demonio) y se comprueba que nada de lo que viene detras sale en verde.
 */
test("con el demonio roto, ni un solo paso sale en verde", async () => {
  // No se rompe el PATH: Bun resuelve "bun" a si mismo aunque no este en el PATH,
  // y eso hacia que este test pasara o fallara segun el orden de la suite.
  process.env.SPOOCHIE_DAEMON_CMD = "/nonexistent/bun run daemon.ts";
  try {
    const pasos = await selftest();
    expect(pasos.length).toBeGreaterThan(0);
    expect(pasos.filter(p => p.ok)).toEqual([]);
    expect(pasos.some(p => p.detalle === "no se ha llegado a probar" || p.que === "la prueba se rompio")).toBe(true);
  } finally {
    delete process.env.SPOOCHIE_DAEMON_CMD;
  }
}, plazo(30_000));
