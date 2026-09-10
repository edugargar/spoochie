import { expect, test } from "bun:test";
import { VERSION, linea, masNuevaQue } from "../src/version.ts";
import { renderMessage } from "../src/threads.ts";

test("la version viene del plugin.json y se compara por lineas", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(linea("0.8.3")).toBe("0.8");
  expect(masNuevaQue("0.8.0", "0.7.9")).toBe(true);
  expect(masNuevaQue("0.7.1", "0.7.1")).toBe(false);
  expect(masNuevaQue("1.0.0", "0.99.99")).toBe(true);
});

test("un mensaje que el vigilante no pudo juzgar se etiqueta como sin vigilar al pintarlo", () => {
  // Desde 0.9.9 un mensaje asi ni siquiera llega a pintarse sin que un humano lo suelte
  // (judge devuelve peligro:true), pero cuando lo suelta, la etiqueta se ve.
  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a", human: "Ana" }, to: { sessionId: "B", name: "b", cwd: "/b", human: "Edu" }, context: {}, state: "open", messages: [] };
  const r = renderMessage(t, { at: 1, from: "A", author: "claude", kind: "text", text: "hola", offTopic: { verdict: "sin vigilar", why: "el vigilante no contesto en dos intentos" } } as any, "B");
  expect(r).toContain("sin vigilar");
  expect(r).toContain("no contesto en dos intentos");
});
