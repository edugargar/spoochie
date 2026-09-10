import { expect, test } from "bun:test";
import { PROTOCOLO, leerVersion } from "../src/protocolo.ts";

test("un sobre de mi version o anterior se entiende", () => {
  expect(leerVersion(PROTOCOLO).entiendo).toBe(true);
  expect(leerVersion(1, "0.9.9").entiendo).toBe(true);
  // Sin `v` es de antes de que esto existiera: se trata como 1.
  expect(leerVersion(undefined).entiendo).toBe(true);
  expect(leerVersion("dos" as any).entiendo).toBe(true);
});

test("un sobre de una version que no conozco no se entrega, y se dice cual falta", () => {
  const l = leerVersion(2, "1.2.0", 1);
  expect(l.entiendo).toBe(false);
  if (l.entiendo) throw new Error("imposible");
  expect(l.por).toContain("protocolo 2");
  expect(l.por).toContain("entiende hasta el 1");
  // Con la version de la otra maquina, para que la persona sepa a quien decirselo.
  expect(l.por).toContain("1.2.0");
  expect(l.por).toContain("plugin marketplace update");
});

test("el numero de protocolo no se escribe a mano en cada sobre", async () => {
  for (const f of ["../src/slack.ts", "../src/nostr.ts"]) {
    const fuente = await Bun.file(new URL(f, import.meta.url)).text();
    // `v: 1` suelto es como estaba antes: diez copias que se olvidan de subir a la vez.
    expect(fuente).not.toContain("v: 1,");
    expect(fuente).toContain("v: PROTOCOLO,");
  }
});
