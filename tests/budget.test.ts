import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LENTO, plazo } from "./wait.ts";

/**
 * Un solo mando para una maquina lenta.
 *
 * `SPOOCHIE_TEST_LENTO` escalaba los sondeos de `hasta()` pero no el plazo de cada test,
 * que es un numero suelto al final de la funcion. La promesa estaba a medias: las
 * esperas se estiraban y el corte seguia donde estaba.
 *
 * Medido con ocho procesos comiendo CPU: cuatro tests en rojo, y ninguno por su logica.
 * El de fugas decia `status: null` porque bun lo habia cortado a los 5.000 ms por
 * defecto, no porque el comprobador fallara. Con los plazos ya multiplicados y
 * SPOOCHIE_TEST_LENTO=3, la misma carga: 250 pass, 0 fail, dos veces.
 *
 * Un test rojo por un plazo corto es peor que no tenerlo, porque no dice "esto tarda
 * mas": dice "esto no pasa", y lo siguiente que hace alguien es mirar el codigo bueno.
 */
test("ningun test fija su plazo a mano: todos pasan por el presupuesto comun", () => {
  const dir = import.meta.dir;
  const sueltos: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    const fuente = readFileSync(join(dir, f), "utf8");
    for (const [i, linea] of fuente.split("\n").entries()) {
      // El plazo de un test es el numero que cierra la llamada: `}, 30_000);`
      if (/^\}, *[0-9_]+\);/.test(linea)) sueltos.push(`${f}:${i + 1}  ${linea.trim()}`);
    }
  }
  expect(sueltos).toEqual([]);
});

test("y el presupuesto multiplica de verdad", () => {
  expect(plazo(1000)).toBe(1000 * LENTO);
  expect(LENTO).toBeGreaterThanOrEqual(1);
});

/**
 * La guarda de arriba mira los plazos que un test DECLARA. El que no declara ninguno se
 * quedaba con los 5 s de bun, que no los mueve SPOOCHIE_TEST_LENTO: medido,
 * `copia.test.ts` fallando a los 5.037 ms con la maquina cargada. El plazo por defecto lo
 * pone ahora `tests/setup.ts`, que es el preload de toda la suite.
 */
test("el plazo por defecto de la suite tambien pasa por el presupuesto", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const setup = readFileSync(join(import.meta.dir, "setup.ts"), "utf8");
  expect(setup).toContain("setDefaultTimeout(plazo(");
  // Y bien por encima de los 5 s de bun, que es donde caian los que lanzan procesos.
  const base = Number(/setDefaultTimeout\(plazo\(([0-9_]+)\)\)/.exec(setup)?.[1].replace(/_/g, "") ?? 0);
  expect(base).toBeGreaterThanOrEqual(20_000);
});
