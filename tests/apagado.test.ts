import { expect, test } from "bun:test";
import * as Cfg from "../src/config.ts";
import { nivelDe, entraSolo } from "../src/confianza.ts";

/**
 * Todo lo nuevo entra apagado.
 *
 * No hay flags de servidor que ir soltando por porcentajes: spoochie se distribuye
 * como un binario por version de plugin, asi que actualizar cambia el comportamiento de
 * todos a la vez. Lo unico que evita que una funcion nueva sorprenda a alguien es que
 * nazca apagada y se encienda a mano. Este test lo comprueba sobre una config recien
 * creada, que es lo que tiene quien acaba de instalar.
 */
test("una config nueva no trae encendida ninguna de las funciones nuevas", () => {
  const c: Cfg.Config = { guardian: true, transcript: false };

  // Consentimiento permanente: nadie entra sin dialogo hasta que lo digas.
  expect(entraSolo(c, { slackUser: "U_SAM" }, "/x/repo")).toBe(false);
  // Confianza: todo el mundo empieza en normal.
  expect(nivelDe(c, { slackUser: "U_SAM" })).toBe("normal");
  // Llavero: los secretos siguen donde estaban hasta que se corra `spoochie llavero on`.
  expect(c.keys?.priv).toBeUndefined();
  // Grupos y continuaciones: solo existen si se pide la bandera.
  expect((c as any).grupo).toBeUndefined();
});

test("las tres cosas que SI nacen encendidas son controles, no funciones", async () => {
  // La diferencia importa: una funcion nueva apagada respeta lo que ya hacia la
  // herramienta; un control apagado por defecto no protege a nadie.
  const aparte = await Bun.file(new URL("../src/aparte.ts", import.meta.url)).text();
  // El portero y el centinela van en los ajustes de arranque, sin condicion.
  expect(aparte).toContain("PreToolUse: [");
  expect(aparte).toContain("Stop: [");
  expect(aparte).not.toContain("if (Cfg.load().portero");
  // El vigilante ya venia encendido por defecto y sigue.
  const cfg = await Bun.file(new URL("../src/config.ts", import.meta.url)).text();
  expect(cfg).toContain("const DEFAULTS: Config = { guardian: true");
});
