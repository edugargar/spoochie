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

test("el script de capturas recorta la ventana, y lo que si es pantalla entera va detras de una bandera", async () => {
  // Medido dos veces: capturar la pantalla entera se llevo primero el dialogo del
  // permiso de Accesibilidad y luego el escritorio de quien lo corria, con las ventanas
  // que tuviera abiertas. En una herramienta cuyo argumento entero es que las cosas no
  // se escapan, eso no puede pasar por defecto.
  const s = await Bun.file(new URL("../scripts/capturas.ts", import.meta.url)).text();
  // El aviso ya no necesita la pantalla: se planta donde le decimos y se recorta su
  // rectangulo exacto, con marco cero para que no entre ni una tira de lo de detras.
  expect(s).toContain("SPOOCHIE_VENTANA_POS");
  expect(s).toContain("MARCO = 0");
  expect(s).toContain('spawnSync("screencapture", ["-x", "-R"');
  // La ventana del aparte es una Terminal y no se puede plantar: esa si es pantalla
  // entera, va detras de la bandera, y al terminar recuerda mirar el PNG.
  expect(s).toContain('if (!process.argv.includes("--pantalla-entera"))');
  expect(s).toContain("MIRA 2-aparte.png antes de ensenarselo a nadie");
  // Y el unico `screencapture` sin region esta dentro de esa rama.
  const [antes, detras] = s.split('if (!process.argv.includes("--pantalla-entera"))');
  expect(antes).not.toContain('screencapture", ["-x", entera]');
  expect(detras).toContain('screencapture", ["-x", entera]');
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

test("las herramientas del aparte van en su sesion principal, no en un subagente", async () => {
  // `--agents` define subagentes a los que despachar; el aparte es la sesion principal
  // de su propio proceso. Declararlo ahi dejaria sin restringir justo al que lee el repo.
  const b = await import("../src/aparte.ts");
  const banderas = b.banderasAparte("v1", "/x/spoochie");
  expect(banderas).not.toContain("--agents");
  expect(banderas).toContain("--allowedTools");
  expect(banderas).toContain("--disallowedTools");
  // Y el motivo escrito donde se tomaria la decision (el comentario si nombra --agents).
  const a = await Bun.file(new URL("../src/aparte.ts", import.meta.url)).text();
  expect(a).toContain("define SUBagentes a los que la sesion puede despachar");
});

test("cada promesa del README nombra el test que la prueba, y ese test existe", async () => {
  // Una promesa sin comprobacion es publicidad. Esto no comprueba que la promesa sea
  // cierta (eso lo hacen los tests nombrados), comprueba que el README no pueda
  // prometer algo apuntando a un fichero que ya no esta.
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const tabla = readme.slice(readme.indexOf("## The promises"), readme.indexOf("## Security model"));
  expect(tabla).toContain("No server of ours");
  expect(tabla).toContain("The model is yours");
  expect(tabla).toContain("Closing deletes it");
  for (const f of ["tests/dos-maquinas-nostr.test.ts", "tests/rele.test.ts", "tests/slack.test.ts", "src/guardian.ts"]) {
    expect(tabla).toContain(f);
    expect(await Bun.file(new URL(`../${f}`, import.meta.url)).exists()).toBe(true);
  }
});

/**
 * Un spoochie cerrado no guarda el texto, se cerrara cuando se cerrara.
 *
 * "Al cerrar se borra" es una de las tres promesas del README y la cumple quien cierra,
 * pero una version anterior podia cerrar sin barrer. Medido en una maquina de verdad:
 * `spoochie doctor` sacaba FALLO con doce spoochies cerrados que aun guardaban lo que se
 * dijo, del 30 de agosto al 4 de septiembre, y no habia forma de arreglarlo. La regla no
 * es "se borra si la version de aquel dia lo hacia": es que un cerrado no lo guarda.
 */
test("el demonio barre al arrancar los cerrados que todavia guardan texto", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { hasta } = await import("./espera.ts");

  const casa = mkdtempSync(join(tmpdir(), "sp-barrido-"));
  mkdirSync(join(casa, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(casa, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: false, human: "Edu" }), { mode: 0o600 });
  const ruta = join(casa, "threads", "viejo.json");
  writeFileSync(ruta, JSON.stringify({
    id: "viejo", subject: "de antes", state: "closed", createdAt: 1, lastActivityAt: 1, closedAt: 1,
    from: { sessionId: "slack:U_A", name: "Ana", cwd: "(otra)" },
    to: { sessionId: "slack:U_B", name: "yo", cwd: "(esta)" },
    context: {}, messages: [{ at: 1, from: "slack:U_A", author: "claude", kind: "text", text: "esto no deberia seguir aqui" }],
  }));
  // Y uno abierto, que no se toca: lo que se barre es lo cerrado.
  const vivo = join(casa, "threads", "vivo.json");
  writeFileSync(vivo, JSON.stringify({
    id: "vivo", subject: "en curso", state: "open", createdAt: 1, lastActivityAt: Date.now(),
    from: { sessionId: "slack:U_A", name: "Ana", cwd: "(otra)" },
    to: { sessionId: "slack:U_B", name: "yo", cwd: "(esta)" },
    context: {}, messages: [{ at: 1, from: "slack:U_A", author: "claude", kind: "text", text: "esto si sigue aqui" }],
  }));

  const d = spawn("bun", ["run", join(import.meta.dir, "..", "src", "daemon.ts")], {
    env: { ...process.env, SPOOCHIE_HOME: casa, SPOOCHIE_AVISO: "terminal", SPOOCHIE_VENTANA: "fondo" }, stdio: "ignore",
  });
  try {
    const conTexto = (f: string) => JSON.parse(readFileSync(f, "utf8")).messages.filter((m: { text?: string }) => m.text).length;
    expect(await hasta(() => conTexto(ruta) === 0)).toBe(true);
    expect(JSON.parse(readFileSync(ruta, "utf8")).borrado).toBeTruthy();
    expect(conTexto(vivo)).toBe(1);
  } finally {
    d.kill("SIGKILL");
  }
});
