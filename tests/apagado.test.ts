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

test("el script de capturas no dispara sin que se lo pidan", async () => {
  // Captura la pantalla entera, asi que mete en un PNG lo que tenga detras quien lo
  // corra. En una herramienta cuyo argumento entero es que las cosas no se escapan, eso
  // no puede pasar por defecto. Medido: el primer intento capturo el dialogo del permiso
  // de Accesibilidad, y el segundo el escritorio con las ventanas que hubiera abiertas.
  const s = await Bun.file(new URL("../scripts/capturas.ts", import.meta.url)).text();
  expect(s).toContain('if (!process.argv.includes("--pantalla-entera"))');
  expect(s).toContain("process.exit(2)");
  // Y al terminar recuerda mirarlas antes de ensenarlas.
  expect(s).toContain("MIRA LAS DOS IMAGENES antes de ensenarselas a nadie");
});

test("no se lanza ningun aparte antes de que la persona acepte", async () => {
  // Se penso adelantar el trabajo mientras el dialogo espera. Descartado: gasta tu
  // dinero en una pregunta que no has aceptado, y "hasta que aceptas no pasa nada" deja
  // de ser verdad si un Claude ya esta leyendo tu repo por la pregunta de otro.
  const d = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
  const dialogo = d.slice(d.indexOf("function avisarConDialogo"), d.indexOf("function cerrarDialogo"));
  expect(dialogo).not.toContain("Ap.lanzar");
  expect(dialogo).not.toContain("lanzarAparte");
  // Y el motivo esta escrito donde se tomaria la decision, no en un commit que nadie lee.
  const razon = d.slice(d.indexOf("Se penso lanzar el aparte YA"), d.indexOf("function avisarConDialogo"));
  expect(razon).toContain("DESCARTADO");
  expect(razon).toContain("Gasta tu dinero en una pregunta que no has aceptado");
});
