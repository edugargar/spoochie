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

/**
 * La especificacion publicada tiene que decir lo que hace el codigo. Un documento de
 * protocolo que se queda atras es peor que no tenerlo: alguien lo implementa y sus
 * sobres se descartan sin que entienda por que.
 */
test("docs/PROTOCOLO.md dice el mismo numero de version que el codigo", async () => {
  const doc = await Bun.file(new URL("../docs/PROTOCOLO.md", import.meta.url)).text();
  expect(doc).toContain(`Protocol version: **${PROTOCOLO}**`);
});

test("el orden de los campos firmados del documento es el del codigo", async () => {
  const doc = await Bun.file(new URL("../docs/PROTOCOLO.md", import.meta.url)).text();
  const firma = await Bun.file(new URL("../src/firma.ts", import.meta.url)).text();
  const enCodigo = firma.slice(firma.indexOf("const datosV2"), firma.indexOf("export function firmar"));
  // Los campos, en orden, tal cual se firman.
  for (const campo of ["d.id", "d.kind", "d.from", "d.to", "d.ts", "d.app", "d.subject"]) {
    expect(enCodigo).toContain(campo);
  }
  const enDoc = doc.slice(doc.indexOf("JSON.stringify(["), doc.indexOf("])", doc.indexOf("JSON.stringify([")));
  for (const campo of ["id,", "kind,", "from,", "to ??", "ts ??", "app ??", "subject ??", "thread ?"]) {
    expect(enDoc).toContain(campo);
  }
  // Y la ventana de tiempo, que es un numero que se puede desincronizar solo.
  expect(doc).toContain("**24 hours**");
  expect(firma).toContain("export const VENTANA_MS = 24 * 60 * 60 * 1000;");
});

test("los kind del documento son los del codigo", async () => {
  const doc = await Bun.file(new URL("../docs/PROTOCOLO.md", import.meta.url)).text();
  const slack = await Bun.file(new URL("../src/slack.ts", import.meta.url)).text();
  const enCodigo = slack.slice(slack.indexOf('kind: "invite"'), slack.indexOf('kind: "invite"') + 120);
  for (const k of ["invite", "msg", "accept", "close", "notice", "hola", "rota"]) {
    expect(enCodigo).toContain(`"${k}"`);
    expect(doc).toContain(k);
  }
});

/**
 * La regla, en el transporte por defecto.
 *
 * `leerVersion` estaba bien y se llamaba en `recibir`, pero `abrir` cortaba antes con
 * `sobre.v !== 1`: un sobre del protocolo 2 se evaporaba sin dejar rastro mientras el
 * otro lado lo veia entregado, y uno sin `v` (de antes de que el campo existiera)
 * tambien. O sea que toda la regla escrita en este fichero y publicada en
 * docs/PROTOCOLO.md era, por Nostr, codigo muerto. Por Slack si se cumplia: las dos
 * rutas hacian cosas distintas con el mismo sobre.
 */
test("por Nostr, un sobre de otra version llega hasta quien sabe que hacer con el", async () => {
  const { envolver, abrir, misClaves } = await import("../src/nostr.ts");
  const yo = misClaves({} as any), otro = misClaves({} as any);
  const manda = (v: unknown) => {
    const { wrap } = envolver(otro.sk, yo.pk, { v, id: "abc", kind: "msg", subject: "s" } as any, "hola");
    return abrir(wrap, yo.sk);
  };
  // Ni el de mas adelante ni el de antes se tiran a la basura aqui.
  expect(manda(2)?.sobre.v).toBe(2);
  expect(manda(undefined)).not.toBeNull();
  expect(manda(1)?.sobre.v).toBe(1);
  // Lo que si se descarta es lo que no es un sobre de spoochie.
  expect(manda("dos")).toBeNull();
});
