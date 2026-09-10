import { expect, test } from "bun:test";
import { juzgarTurno } from "../src/centinela.ts";

const hilo = (msgs: any[], state = "open"): any => ({
  id: "c1", subject: "s", state,
  from: { sessionId: "ELLOS", name: "ana", cwd: "/a", human: "Ana" },
  to: { sessionId: "YO", name: "yo", cwd: "/b", human: "Edu" },
  context: {}, messages: msgs,
});
const msg = (from: string, x: any = {}) => ({ at: 1, from, author: "claude", kind: "text", text: "x", ...x });

test("si el ultimo mensaje es del otro lado, no se puede callar", () => {
  const d = juzgarTurno(hilo([msg("ELLOS")]), "YO", false);
  expect(d.decision).toBe("block");
  expect(d.reason).toContain("spoochie say c1");
  expect(d.reason).toContain("spoochie close c1");
});

test("si ya se contesto, se calla tranquilo", () => {
  expect(juzgarTurno(hilo([msg("ELLOS"), msg("YO")]), "YO", false).decision).toBeUndefined();
});

test("un mensaje retenido por el vigilante no espera respuesta: espera a su humano", () => {
  const t = hilo([msg("ELLOS"), msg("YO"), msg("ELLOS", { retenido: "si" })]);
  expect(juzgarTurno(t, "YO", false).decision).toBeUndefined();
  const descartado = hilo([msg("ELLOS"), msg("YO"), msg("ELLOS", { retenido: "descartado" })]);
  expect(juzgarTurno(descartado, "YO", false).decision).toBeUndefined();
});

test("no se bloquea dos veces seguidas: un aparte en bucle es peor que uno callado", () => {
  expect(juzgarTurno(hilo([msg("ELLOS")]), "YO", true).decision).toBeUndefined();
});

test("un hilo cerrado o inexistente no bloquea nada", () => {
  expect(juzgarTurno(hilo([msg("ELLOS")], "closed"), "YO", false).decision).toBeUndefined();
  expect(juzgarTurno(hilo([msg("ELLOS")], "pending"), "YO", false).decision).toBeUndefined();
  expect(juzgarTurno(null, "YO", false).decision).toBeUndefined();
});

test("un hilo sin mensajes todavia no reclama nada", () => {
  expect(juzgarTurno(hilo([]), "YO", false).decision).toBeUndefined();
});
