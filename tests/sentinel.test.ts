import { expect, test } from "bun:test";
import { judgeTurn } from "../src/sentinel.ts";

const hilo = (msgs: any[], state = "open"): any => ({
  id: "c1", subject: "s", state,
  from: { sessionId: "ELLOS", name: "ana", cwd: "/a", human: "Ana" },
  to: { sessionId: "YO", name: "yo", cwd: "/b", human: "Edu" },
  context: {}, messages: msgs,
});
const msg = (from: string, x: any = {}) => ({ at: 1, from, author: "claude", kind: "text", text: "x", ...x });

test("si el ultimo mensaje es del otro lado, no se puede callar", () => {
  const d = judgeTurn(hilo([msg("ELLOS")]), "YO", false);
  expect(d.decision).toBe("block");
  expect(d.reason).toContain("spoochie say c1");
  expect(d.reason).toContain("spoochie close c1");
});

test("si ya se contesto, se calla tranquilo", () => {
  expect(judgeTurn(hilo([msg("ELLOS"), msg("YO")]), "YO", false).decision).toBeUndefined();
});

test("un mensaje retenido por el vigilante no espera respuesta: espera a su humano", () => {
  const t = hilo([msg("ELLOS"), msg("YO"), msg("ELLOS", { retenido: "si" })]);
  expect(judgeTurn(t, "YO", false).decision).toBeUndefined();
  const descartado = hilo([msg("ELLOS"), msg("YO"), msg("ELLOS", { retenido: "descartado" })]);
  expect(judgeTurn(descartado, "YO", false).decision).toBeUndefined();
});

test("no se bloquea dos veces seguidas: un aparte en bucle es peor que uno callado", () => {
  expect(judgeTurn(hilo([msg("ELLOS")]), "YO", true).decision).toBeUndefined();
});

test("un hilo cerrado o inexistente no bloquea nada", () => {
  expect(judgeTurn(hilo([msg("ELLOS")], "closed"), "YO", false).decision).toBeUndefined();
  expect(judgeTurn(hilo([msg("ELLOS")], "pending"), "YO", false).decision).toBeUndefined();
  expect(judgeTurn(null, "YO", false).decision).toBeUndefined();
});

test("un hilo sin mensajes todavia no reclama nada", () => {
  expect(judgeTurn(hilo([]), "YO", false).decision).toBeUndefined();
});

/**
 * El aviso de lo no leido, que es la unica proactividad que se permite spoochie:
 * hechos del hilo, nunca iniciativa sobre el trabajo. Las condiciones estan en
 * `avisarDeLoNoLeido` (daemon.ts) y aqui se prueba la logica que las decide.
 */
import { readFileSync } from "node:fs";

test("el aviso de lo no leido solo sale de un tunel que llego a abrirse", async () => {
  const fuente = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  const f = fuente.slice(fuente.indexOf("async function avisarDeLoNoLeido"), fuente.indexOf("async function tick"));
  // Si lo rechazaste, recordarte el mensaje que rechazaste es lo contrario de
  // respetar la decision.
  expect(f).toContain("if (!t.acceptedAt) return;");
  // Si contestamos nosotros los ultimos, no hay nada pendiente.
  expect(f).toContain("if (ultimo.from === mio) return;");
  // Si lo cerraste tu, cerrar fue tu respuesta: lo has visto.
  expect(f).toContain("if (cerradoPor === mio) return;");
  expect(fuente).toContain("await avisarDeLoNoLeido(t, bySession);");
  // Si el aparte sigue vivo, ya lo ha visto.
  expect(f).toContain("if (ap && !ap.muerto");
  // Y lo que dice son hechos: quien, cuando, el texto y donde esta el hilo entero.
  expect(f).toContain("sin respuesta tuya");
  expect(f).toContain("no abras otro spoochie por tu cuenta");
});

test("quien abre sabe que la respuesta le llega sola y no la espera en primer plano", () => {
  // Prueba real del 01-10: un bucle de `spoochie show` + sleep en primer plano dejo la
  // respuesta de Bea 4 min 28 s en el buzon sin poder entrar como turno.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const open = cli.slice(cli.indexOf('case "open": {'), cli.indexOf('case "take":'));
  expect(open).toContain("console.log(`\\n${COMO_ESPERAR}`)");
  expect(cli).toContain("Ahora termina tu turno. La respuesta te llegara sola");
  const skill = readFileSync(new URL("../commands/spoochie.md", import.meta.url), "utf8");
  expect(skill).toContain("Despues de abrir, termina tu turno.");
  expect(skill).toContain("No la esperes con `spoochie show`, sleep, bucles ni Monitor");
});
