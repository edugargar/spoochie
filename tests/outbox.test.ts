import { expect, test } from "bun:test";
import * as T from "../src/threads.ts";
import { enqueue } from "../src/outbox.ts";

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

function hilo(id: string): T.Thread {
  const t: T.Thread = {
    id, subject: "prueba", state: "open", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: "A", name: "a", cwd: "/tmp/a" },
    to: { sessionId: "B", name: "b", cwd: "/tmp/b" },
    context: {}, messages: [],
  } as any;
  T.save(t);
  return t;
}

const msg = (text: string, files?: string[]): T.Msg =>
  ({ at: Date.now(), from: "A", author: "claude", kind: "text", text, ...(files ? { files } : {}) });

test("los mensajes seguidos salen como uno y no se pierde ningun adjunto", async () => {
  const t = hilo("ob01");
  const salidas: T.Msg[] = [];
  const salida = async (_t: T.Thread, m: T.Msg) => { salidas.push(m); };

  enqueue(t, msg("parte uno", ["/tmp/uno.png"]), salida, 40);
  enqueue(t, msg("parte dos", ["/tmp/dos.png"]), salida, 40);
  enqueue(t, msg("parte tres", ["/tmp/dos.png"]), salida, 40);
  await dormir(150);

  expect(salidas.length).toBe(1);
  expect(salidas[0].text).toBe("parte uno\n\nparte dos\n\nparte tres");
  // El adjunto del segundo llegaba antes al limbo, y el repetido no se manda dos veces.
  expect(salidas[0].files).toEqual(["/tmp/uno.png", "/tmp/dos.png"]);
});

test("sin adjuntos no se inventa una lista vacia", async () => {
  const t = hilo("ob02");
  const salidas: T.Msg[] = [];
  enqueue(t, msg("solo texto"), async (_t, m) => { salidas.push(m); }, 40);
  await dormir(150);
  expect(salidas.length).toBe(1);
  expect("files" in salidas[0]).toBe(false);
});

test("un parche sale solo y al momento, sin esperar a la ventana", async () => {
  const t = hilo("ob03");
  const salidas: T.Msg[] = [];
  const salida = async (_t: T.Thread, m: T.Msg) => { salidas.push(m); };
  enqueue(t, { ...msg("texto"), kind: "patch" }, salida, 5_000);
  await dormir(30);
  expect(salidas.length).toBe(1);
  expect(salidas[0].kind).toBe("patch");
});

test("se manda el hilo recien leido de disco, no la copia de hace dos segundos", async () => {
  const t = hilo("ob04");
  const vistos: T.Thread[] = [];
  enqueue(t, msg("hola"), async (tt) => { vistos.push(tt); }, 60);
  // Mientras espera la ventana, el otro lado cierra el hilo.
  T.save({ ...T.load("ob04")!, state: "closed" });
  await dormir(200);
  expect(vistos.length).toBe(1);
  expect(vistos[0].state).toBe("closed");
});

test("cada lado tiene su propia ventana: no se mezclan las voces", async () => {
  const t = hilo("ob05");
  const salidas: T.Msg[] = [];
  const salida = async (_t: T.Thread, m: T.Msg) => { salidas.push(m); };
  enqueue(t, msg("digo yo"), salida, 40);
  enqueue(t, { ...msg("digo yo"), from: "B", text: "digo el otro" }, salida, 40);
  await dormir(150);
  expect(salidas.length).toBe(2);
  expect(salidas.map(m => m.text).sort()).toEqual(["digo el otro", "digo yo"]);
});

test("lo pendiente se apunta en disco, un demonio nuevo lo reanuda, y lo que falla se reintenta", async () => {
  const { enqueue, resume, pending } = await import("../src/outbox.ts");
  const { OUTBOX_FILE } = await import("../src/paths.ts");
  const { existsSync, readFileSync } = await import("node:fs");
  const Tm = await import("../src/threads.ts");
  const t: any = { id: "ob9", subject: "s", state: "open", createdAt: 0, lastActivityAt: 0, context: {}, messages: [],
    from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "slack:U1", name: "b", cwd: "(otra)" } };
  Tm.save(t);
  const salidas: string[] = [];
  let falla = true;
  const salida = async (_t: any, m: any) => { salidas.push(m.text); return !falla; };
  enqueue(t, { at: 1, from: "A", author: "claude", kind: "text", text: "uno" } as any, salida, 30);
  // Antes de que pase la ventana ya esta en disco.
  expect(existsSync(OUTBOX_FILE)).toBe(true);
  expect(readFileSync(OUTBOX_FILE, "utf8")).toContain("uno");
  await new Promise(r => setTimeout(r, 120));
  // Salio, fallo, y sigue apuntado con el fallo contado.
  expect(salidas).toEqual(["uno"]);
  expect(pending()).toBe(1);
  expect(JSON.parse(readFileSync(OUTBOX_FILE, "utf8"))[0].fallos).toBe(1);
  // Un "demonio nuevo" reanuda lo del fichero y esta vez Slack acepta: el fichero desaparece.
  falla = false;
  resume(salida);
  await new Promise(r => setTimeout(r, 120));
  expect(salidas).toEqual(["uno", "uno"]);
  expect(pending()).toBe(0);
  expect(existsSync(OUTBOX_FILE)).toBe(false);
});
