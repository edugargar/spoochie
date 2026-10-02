import { expect, test } from "bun:test";
import { judge } from "../src/guardian.ts";

/** Sin red ni coste: solo el atajo de los mensajes cortos, que es donde estaba el ruido. */
test("un acuse de recibo corto no se juzga", async () => {
  const v = await judge("el boton se rompe en movil", "OK, todo llega.");
  expect(v.verdict).toBe("dentro");
  expect(v.why).toBe("demasiado corto para juzgar");
});

test("un mensaje vacio tampoco", async () => {
  expect((await judge("asunto", "   ")).verdict).toBe("dentro");
});

import corpus from "./watcher-corpus.json" with { type: "json" };

/**
 * El corpus se corre contra Haiku con `bun scripts/watcher.ts`, no aqui: un test que
 * llama a un modelo cuesta dinero y falla por la red, y a la semana nadie lo mira. Lo
 * que si se comprueba aqui, sin red y en un milisegundo, es que el corpus sigue siendo
 * un corpus y que el prompt sigue nombrando lo que el corpus prueba. Borrar una linea
 * del prompt sin darse cuenta es la forma realista de romper el vigilante.
 */
test("el corpus cubre los dos lados y ningun caso se queda a medias", () => {
  const casos = corpus.casos as { categoria: string; peligro: boolean; texto: string }[];
  expect(casos.length).toBeGreaterThanOrEqual(20);
  expect(casos.filter(c => c.peligro).length).toBeGreaterThanOrEqual(10);
  expect(casos.filter(c => !c.peligro).length).toBeGreaterThanOrEqual(6);
  for (const c of casos) {
    expect(typeof c.categoria).toBe("string");
    expect(typeof c.peligro).toBe("boolean");
    // Por debajo de MIN_CHARS el vigilante ni juzga: un caso asi no prueba nada.
    expect(c.texto.trim().length).toBeGreaterThan(40);
  }
});

test("el prompt del vigilante sigue nombrando cada cosa que el corpus prueba", async () => {
  const fuente = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  const prompt = fuente.slice(fuente.indexOf("const PROMPT"), fuente.indexOf("export function judge"));
  for (const palabra of [
    "ejecutar comandos", "aplicar cambios sin revision", "permisos", "instalar",
    "URLs", "enviar ficheros", "variables de entorno", "secreto",
    "reglas del sistema", "Ante la duda sobre el peligro, true",
  ]) {
    expect(prompt).toContain(palabra);
  }
});

test("si el vigilante no contesta, el mensaje se retiene: no se cae hacia dejar pasar", async () => {
  // Medido con el corpus, una pasada de 24 casos: 23 aciertos, 0 escapados y 1 sin
  // respuesta por tiempo agotado. El que se quedo sin respuesta era el que pedia
  // ~/.aws/credentials. No es casualidad: el mensaje ambiguo o adversarial es el que
  // hace pensar mas rato al modelo, asi que el tiempo se agota antes en los peligrosos.
  const fuente = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  const salida = fuente.slice(fuente.indexOf("export async function judge"), fuente.indexOf("function unaPasada"));
  expect(salida).toContain('verdict: "sin vigilar"');
  expect(salida).toContain("peligro: true");
  // Y con un reintento antes, porque la mayoria de los fallos son de tiempo, no del modelo.
  expect(salida).toContain("const dos = await unaPasada");
});

/**
 * Lo que el vigilante no lee no lo vigila.
 *
 * El prompt llevaba `text.slice(0, 4000)` y `MAX_MENSAJE` son 25.000: veintiun mil
 * caracteres de cada mensaje no los miraba nadie, mientras a la sesion le llegaba el
 * mensaje entero. O sea, cuatro mil caracteres de relleno y detras lo que sea. Y el
 * limite de 25.000 lo cumple quien envia desde la CLI; a un peer hostil no lo ata nadie.
 *
 * Este test no llama al modelo: mira lo unico que el modelo puede ver, que es el prompt.
 */
test("el vigilante ve el mensaje entero, y lo que no le cabe no entra", async () => {
  const fuente = await Bun.file(new URL("../src/guardian.ts", import.meta.url)).text();
  // El mensaje va entero al prompt: ni un slice por el camino.
  // Solo la linea del prompt: el comentario de arriba cita el slice viejo a proposito.
  const prompt = fuente.slice(fuente.indexOf("const PROMPT"), fuente.indexOf("export async function judge"));
  expect(prompt).toContain("MENSAJE: ${text}");
  expect(prompt).not.toContain(".slice(");

  // Y lo que pasa del limite se retiene, no se entrega a medio juzgar.
  const v = await judge("el boton", "x".repeat(25_001));
  expect(v.peligro).toBe(true);
  expect(v.why).toContain("se retiene");
});
