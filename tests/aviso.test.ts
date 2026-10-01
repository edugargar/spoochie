import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { guionVentana, piezas, recortar, posicionPedida, ANCHO, BOTONES } from "../src/ventana.ts";
import { plazo } from "./espera.ts";

const hilo = (extra: any = {}): any => ({
  id: "v1", subject: "el guardado revienta",
  from: { sessionId: "slack:U1", name: "ana", human: "Ana", cwd: "/x" },
  to: { sessionId: "S", name: "repo", cwd: "/y" },
  context: { branch: "feat/x", files: ["a.ts", "b.ts"] },
  messages: [{ at: 1, from: "slack:U1", author: "claude", kind: "text", text: "mira tu Button" }],
  ...extra,
});

/** El literal de datos que el guion lleva al principio. */
function datos(guion: string): any {
  const l = guion.split("\n").find(x => x.startsWith("var D = "))!;
  return JSON.parse(l.slice("var D = ".length, -1));
}

test("el aviso dice quien llama primero, y solo pinta el contexto que existe", () => {
  const p = piezas(hilo());
  expect(p.quien).toBe("Ana llama.");
  // El asunto entra con mayuscula inicial aunque quien lo escribio no la pusiera.
  expect(p.asunto).toBe("El guardado revienta");
  expect(p.contexto).toBe("feat/x · 2 ficheros");
  expect(p.cita).toBe("mira tu Button");
  // Ni etiquetas de formulario ni entradillas de broma.
  expect(JSON.stringify(p)).not.toContain("Asunto:");
  expect(JSON.stringify(p)).not.toContain("Poochie");
  // Sin rama ni ficheros no queda una linea vacia esperando texto.
  expect(piezas(hilo({ context: {} })).contexto).toBe("");
  expect(piezas(hilo({ context: { files: ["solo.ts"] } })).contexto).toBe("1 fichero");
});

test("un cuerpo largo se corta tras un punto, no a mitad de palabra", () => {
  const largo = "Una frase que ocupa lo suyo y termina aqui. ".repeat(12);
  const c = recortar(largo);
  expect(c.length).toBeLessThan(largo.length);
  expect(c).toMatch(/\.\s…$/);
  expect(recortar("  corto  ")).toBe("corto");
});

/**
 * Lo importante de este fichero.
 *
 * El asunto y el mensaje los escribe otra persona, y acaban dentro de un programa que
 * este proceso ejecuta. Van en un literal JSON al principio y no interpolados por el
 * cuerpo, asi que unas comillas y un punto y coma no cierran nada: se quedan siendo el
 * contenido de una cadena. Es la misma regla que el portero.
 */
test("el texto de otra persona viaja como dato, no como codigo", () => {
  const veneno = `"; $.NSApplication.sharedApplication.terminate(null); //`;
  const g = guionVentana(hilo({ subject: veneno, messages: [{ at: 1, from: "x", author: "claude", kind: "text", text: veneno }] }), null);
  const d = datos(g);
  expect(d.asunto).toContain("terminate");
  expect(d.cita).toContain("terminate");
  // Y fuera del literal de datos, ni rastro: nada del texto de fuera llega al cuerpo.
  const cuerpo = g.split("\n").filter(l => !l.startsWith("var D = ")).join("\n");
  expect(cuerpo).not.toContain("terminate");
});

test("los tres botones, con el Return en el que acepta", () => {
  const d = datos(guionVentana(hilo(), null));
  expect(d.botones.map((b: any) => b.titulo)).toEqual([BOTONES.rechazar, BOTONES.slack, BOTONES.aceptar]);
  expect(d.botones.find((b: any) => b.titulo === BOTONES.aceptar).tecla).toBe("\r");
  expect(d.ancho).toBe(ANCHO);
  // Los tags son los que el guion devuelve por stdout, y tienen que ser distintos.
  expect(new Set(d.botones.map((b: any) => b.tag)).size).toBe(3);
});

test("la posicion solo se acepta si son dos numeros", () => {
  const antes = process.env.SPOOCHIE_VENTANA_POS;
  try {
    delete process.env.SPOOCHIE_VENTANA_POS;
    expect(posicionPedida()).toBeNull();
    process.env.SPOOCHIE_VENTANA_POS = "200, 160";
    expect(posicionPedida()).toEqual({ x: 200, y: 160 });
    process.env.SPOOCHIE_VENTANA_POS = "arriba a la izquierda";
    expect(posicionPedida()).toBeNull();
  } finally {
    if (antes === undefined) delete process.env.SPOOCHIE_VENTANA_POS; else process.env.SPOOCHIE_VENTANA_POS = antes;
  }
});

/**
 * El guion es JavaScript, y un fallo de sintaxis aqui no se ve hasta que llega un
 * spoochie de verdad y la persona no se entera de nada. `osascript -c` no existe, pero
 * `Function()` compila sin ejecutar y con eso basta para el error de sintaxis.
 */
test("el guion compila como JavaScript", () => {
  const g = guionVentana(hilo({ subject: "acentos: ñ á “comillas” y \\ barras" }), "/tmp/no-existe.png");
  expect(() => new Function(g)).not.toThrow();
});

test.if(process.platform === "darwin")("y macOS lo entiende: JXA lo lee entero sin ejecutarlo", () => {
  // `osascript` con la ventana dentro se quedaria esperando a que alguien pulse. Se le
  // manda el guion partido justo antes de pintar: si lo que va delante tuviera un error
  // de sintaxis o una clase que este macOS no trae, saldria aqui.
  const g = guionVentana(hilo(), null).split("if (D.clic) {")[0];
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", g + `console.log("montada:" + alto);`], { encoding: "utf8" });
  expect(r.stdout + r.stderr).toContain("montada:");
  expect(r.status).toBe(0);
}, plazo(20_000));

/**
 * El clic de verdad, sin que se vea.
 *
 * Hasta el 01-10 la ventana se probaba con capturas y mirando el guion, nunca pulsando un
 * boton. `runModalForWindow` devuelve el codigo como CADENA ("3"), el guion lo comparaba
 * con `===` contra el numero 3, y el nombre del boton salia vacio: la persona pulsaba
 * "Que pase", el demonio leia "button returned:" y lo registraba como "sin respuesta".
 * Una persona abrio un spoochie, a la otra le salto el aviso, pulso aceptar y no paso nada.
 *
 * Con SPOOCHIE_VENTANA_CLIC la ventana real sale transparente, sin Dock y sin foco, y un
 * temporizador pulsa el boton. Se lee lo que imprime, que es lo que lee el demonio.
 * Necesita AppKit: solo en un Mac con sesion grafica, y no en CI.
 */
const conPantalla = process.platform === "darwin" && !process.env.CI;
const ahoraEnPrimerPlano = () => spawnSync("osascript", ["-l", "JavaScript", "-e",
  "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js"], { encoding: "utf8" }).stdout.trim();

/** Corre el guion y mira quien esta en primer plano mientras la ventana existe. Que la
 *  persona cambie de aplicacion por su cuenta no es de la ventana: lo que no puede pasar
 *  es que sea la ventana quien se ponga delante. */
async function correrYMirarElFoco(guion: string) {
  const { spawn } = await import("node:child_process");
  const hijo = spawn("osascript", ["-l", "JavaScript", "-e", guion], { stdio: ["ignore", "pipe", "pipe"] });
  let salida = "";
  hijo.stdout.on("data", d => { salida += d.toString(); });
  hijo.stderr.on("data", d => { salida += d.toString(); });
  const fin = new Promise<number | null>(r => hijo.on("close", r));
  const delante = new Set<string>();
  let termino = false;
  void fin.then(() => { termino = true; });
  // Con un await por vuelta: sin el, el bucle no suelta el hilo, el `close` del hijo no
  // llega nunca a `termino` y el test se colgaba hasta el plazo (60 s, tres veces).
  while (!termino) { delante.add(ahoraEnPrimerPlano()); await new Promise(r => setTimeout(r, 20)); }
  return { salida, codigo: await fin, delante };
}

for (const [titulo, tag, esperado] of [["Que pase", 3, "acepto"], ["Ahora no", 1, "rechazo"], ["Ver en Slack", 2, "slack"]] as const) {
  test.if(conPantalla)(`pulsar "${titulo}" en la ventana real llega al demonio como ${esperado}, siempre y sin tomar el foco`, async () => {
    const { interpretar } = await import("../src/dialogo.ts");
    process.env.SPOOCHIE_VENTANA_CLIC = String(tag);
    let guion: string;
    try { guion = guionVentana(hilo({ id: `clic${tag}` })); } finally { delete process.env.SPOOCHIE_VENTANA_CLIC; }
    // Varias vueltas: el 01-10 un clic dio el boton equivocado una de cada seis veces.
    for (let i = 0; i < 6; i++) {
      const r = await correrYMirarElFoco(guion);
      expect(r.salida).toContain(`button returned:${titulo}`);
      expect(interpretar(r.salida, r.codigo)).toBe(esperado);
      // Ni osascript ni la ventana se pusieron delante de lo que la persona estaba haciendo.
      expect([...r.delante].filter(n => /osascript|Script Editor/i.test(n))).toEqual([]);
    }
  }, plazo(60_000));
}

test("sin SPOOCHIE_VENTANA_CLIC el guion de produccion no lleva ningun clic automatico ni es invisible", () => {
  delete process.env.SPOOCHIE_VENTANA_CLIC;
  const g = guionVentana(hilo());
  expect(datos(g).clic).toBe(0);
  // El bloque de la prueba existe en el guion, pero detras de `if (D.clic)`: con 0 no corre.
  expect(g).toContain("if (D.clic) {");
  process.env.SPOOCHIE_VENTANA_CLIC = "9";
  try { expect(datos(guionVentana(hilo())).clic).toBe(0); } finally { delete process.env.SPOOCHIE_VENTANA_CLIC; }
});
