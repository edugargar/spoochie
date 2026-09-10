import { expect, test, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bajar, SPOOL, MAX_BYTES } from "../src/files.ts";

/** Una URL de las que pone Slack de verdad. Desde que `bajar` mira el anfitrion, una
 *  cadena cualquiera ya no vale, y eso es lo que se quiere. */
const URL_OK = "https://files.slack.com/files-pri/T1-F1/captura.png";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

function sirve(cuerpo: Uint8Array, ok = true) {
  globalThis.fetch = (async () => ({
    ok, arrayBuffer: async () => cuerpo.buffer.slice(cuerpo.byteOffset, cuerpo.byteOffset + cuerpo.byteLength),
  })) as any;
}

test("un nombre con ../ no escribe fuera del spool", async () => {
  sirve(new TextEncoder().encode("hola"));
  const rutas = await bajar("t", [{ id: "F1", name: "../../../fuera.txt", url_private_download: URL_OK }], "h1");
  expect(rutas.length).toBe(1);
  expect(rutas[0].startsWith(join(SPOOL, "h1") + "/")).toBe(true);
  // Las barras se quedan en _, asi que los puntos que sobreviven no llevan a ningun lado.
  expect(rutas[0].slice(join(SPOOL, "h1").length + 1)).not.toContain("/");
  expect(readFileSync(rutas[0], "utf8")).toBe("hola");
});

test("el id tampoco se cuela: tambien lo pone el otro lado", async () => {
  sirve(new TextEncoder().encode("x"));
  const rutas = await bajar("t", [{ id: "../../../evil", name: "a.txt", url_private_download: URL_OK }], "h2");
  expect(rutas.length).toBe(1);
  expect(rutas[0].startsWith(join(SPOOL, "h2") + "/")).toBe(true);
  expect(existsSync(join(SPOOL, "h2"))).toBe(true);
});

test("lo que pasa del limite no toca el disco", async () => {
  sirve(new Uint8Array(MAX_BYTES + 1));
  const rutas = await bajar("t", [{ id: "F2", name: "gordo.bin", url_private_download: URL_OK }], "h3");
  expect(rutas).toEqual([]);
});

test("un fichero sin url se salta sin tumbar los demas", async () => {
  sirve(new TextEncoder().encode("ok"));
  const rutas = await bajar("t", [{ id: "F3", name: "sin-url.txt" }, { id: "F4", name: "con-url.txt", url_private: URL_OK }], "h4");
  expect(rutas.length).toBe(1);
  expect(rutas[0]).toContain("con-url.txt");
});

test("una descarga que falla no deja medio fichero", async () => {
  sirve(new TextEncoder().encode("x"), false);
  const rutas = await bajar("t", [{ id: "F5", name: "a.txt", url_private_download: URL_OK }], "h5");
  expect(rutas).toEqual([]);
});

/**
 * `bajar` manda el token del bot como `Authorization` a la URL que diga el mensaje. Hoy
 * ese campo lo pone la API de Slack por TLS, asi que no habia agujero abierto: habia una
 * funcion que dependia de que nadie la llamara mal. Una URL con otro anfitrion se lleva
 * el token del equipo entero, y eso no se arregla despues.
 */
test("una url que no es de Slack no se pide, aunque venga en el sitio de siempre", async () => {
  const pedidas: string[] = [];
  globalThis.fetch = (async (u: any) => { pedidas.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; }) as any;
  const rutas = await bajar("token-del-bot", [
    { id: "F6", name: "a.txt", url_private_download: "https://files.slack.com.mio.example/x" },
    { id: "F7", name: "b.txt", url_private_download: "http://files.slack.com/x" },   // sin TLS tampoco
    { id: "F8", name: "c.txt", url_private_download: URL_OK },
  ], "h6");
  expect(rutas.length).toBe(1);
  expect(pedidas).toEqual([URL_OK]);
});

test("y el id del hilo se limpia aqui aunque venga limpio de fuera", async () => {
  sirve(new TextEncoder().encode("x"));
  const rutas = await bajar("t", [{ id: "F9", name: "a.txt", url_private_download: URL_OK }], "../../../fuera");
  expect(rutas.length).toBe(1);
  // Los puntos pueden sobrevivir; lo que no sobrevive son las barras, asi que el
  // ".." se queda en un nombre de directorio feo y no en un salto.
  expect(resolve(rutas[0]).startsWith(resolve(SPOOL) + "/")).toBe(true);
  expect(rutas[0].slice(SPOOL.length + 1).split("/").length).toBe(2);
});

/**
 * El spool de un hilo que nunca llego a existir.
 *
 * Un trozo puede llegar antes que la invitacion, asi que espera en el spool: eso esta
 * bien y es necesario, los reles no ordenan. Lo que no estaba previsto es que la
 * invitacion no llegue nunca. El barrido del demonio recorre los hilos, y de un hilo que
 * no existe no se ocupaba nadie: medido, un fichero de un contacto se quedaba en
 * ~/.claude/spoochie/files/<id>/ para siempre, sin salir en ningun sitio donde alguien
 * lo viera. Y antes de que a nadie le hubieran preguntado nada.
 */
test("lo que se queda en el spool sin hilo que lo reclame se barre; lo que tiene hilo, no", async () => {
  const { barrerHuerfanos } = await import("../src/files.ts");
  const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const TTL = 4 * 60 * 60 * 1000;
  const viejo = (Date.now() - TTL - 60_000) / 1000;

  for (const id of ["huerfano", "conhilo", "reciente"]) {
    mkdirSync(join(SPOOL, id), { recursive: true, mode: 0o700 });
    writeFileSync(join(SPOOL, id, "x.bin"), "x", { mode: 0o600 });
  }
  utimesSync(join(SPOOL, "huerfano"), viejo, viejo);
  utimesSync(join(SPOOL, "conhilo"), viejo, viejo);

  const barridos = barrerHuerfanos(id => id === "conhilo", TTL);
  expect(barridos).toEqual(["huerfano"]);
  expect(existsSync(join(SPOOL, "huerfano"))).toBe(false);
  // El que tiene hilo vivo no se toca aunque sea viejo: de ese se ocupa `purgar` al cerrar.
  expect(existsSync(join(SPOOL, "conhilo"))).toBe(true);
  // Y al que acaba de llegar se le deja llegar su invitacion.
  expect(existsSync(join(SPOOL, "reciente"))).toBe(true);
});
