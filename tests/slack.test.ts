import { expect, test } from "bun:test";
import { SlackBridge, envelopeOf, inviteBlocks, messageBlocks, noticeBlocks, fallbackText, chunk, esAcuse, bodyFromBlocks, cadenciaDescubrir, EVENT, type Envelope } from "../src/slack.ts";
import { MAX_PARCHE } from "../src/threads.ts";
import type { Thread, Msg } from "../src/threads.ts";

const t: Thread = {
  id: "a3f1", subject: "el modal se cierra al pulsar Guardar",
  from: { sessionId: "A", name: "a", cwd: "/a", human: "Edu", slackUser: "U_EDU" },
  to: { sessionId: "B", name: "b", cwd: "/b", human: "Sam", slackUser: "U_SAM" },
  state: "open", createdAt: 0, lastActivityAt: 0,
  context: { branch: "feat/perfil", sha: "cafe12345678", files: ["src/Modal.tsx"] },
  messages: [{ at: 0, from: "A", author: "claude", kind: "text", text: "se cierra antes del POST" }],
};
const msg = (o: Partial<Msg>): Msg => ({ at: 0, from: "A", author: "claude", kind: "text", text: "x", ...o });
const flat = (b: unknown[]) => JSON.stringify(b);

test("el sobre de maquina se reconoce por event_type y payload", () => {
  const env: Envelope = { v: 1, id: "a3f1", kind: "msg", from: "U_EDU" };
  expect(envelopeOf({ metadata: { event_type: EVENT, event_payload: env } })).toEqual(env);
});

test("un mensaje escrito a mano en Slack no tiene sobre", () => {
  expect(envelopeOf({ text: "hola" })).toBeNull();
  expect(envelopeOf({ metadata: { event_type: "otra_cosa", event_payload: { id: "x", from: "y" } } })).toBeNull();
});

test("la invitacion menciona a quien recibe y dice como aceptar", () => {
  const b = flat(inviteBlocks(t));
  expect(b).toContain("<@U_SAM>");
  expect(b).toContain("spoochie accept a3f1");
  expect(b).toContain("Spoochie de Edu");
  expect(b).toContain("feat/perfil");
  expect(b).toContain("src/Modal.tsx");
});

test("la capa de Slack no lleva las instrucciones internas del receptor", () => {
  const b = flat(messageBlocks(t, msg({ text: "el catch no limpia el estado" })));
  expect(b).toContain("el catch no limpia el estado");
  expect(b).not.toContain("No apliques cambios");
  expect(b).not.toContain("spoochie say");
});

test("se distingue lo que dice la persona de lo que dice su Claude", () => {
  expect(flat(messageBlocks(t, msg({ author: "human" })))).toContain("en persona");
  expect(flat(messageBlocks(t, msg({ author: "claude" })))).toContain("su Claude");
});

test("el aviso del vigilante tambien se ve en Slack, sin borrar el mensaje", () => {
  const b = flat(messageBlocks(t, msg({ text: "donde comemos", offTopic: { verdict: "fuera", why: "comida" } })));
  expect(b).toContain("donde comemos");
  expect(b).toContain("fuera");
  expect(flat(messageBlocks(t, msg({ offTopic: { verdict: "dentro", why: "" } })))).not.toContain("vigilante");
});

test("un parche va en bloque de codigo y avisa de que no lo aplica nadie por ti", () => {
  const b = flat(messageBlocks(t, msg({ kind: "patch", text: "--- a\n+++ b\n-x\n+y" })));
  expect(b).toContain("```");
  expect(b).toContain("nadie escribe en tu");
  expect(b).toContain("+y");
});

test("los avisos del sistema no arrastran el texto interno a Slack", () => {
  const acc = noticeBlocks({ ...t, acceptedBy: "Sam" }, '[spoochie a3f1] b ha aceptado el tunel.\nYa podeis hablar: spoochie say a3f1 "<texto>"');
  expect(acc.text).toContain("Sam");
  expect(acc.text).not.toContain("spoochie say");
  expect(acc.text).not.toContain("<texto>");
  const cl = noticeBlocks({ ...t, closeReason: "resuelto" }, "[spoochie a3f1 | s] cerrado (resuelto).");
  expect(cl.text).toContain("resuelto");
  expect(cl.text).not.toContain("[spoochie");
});

test("el texto de respaldo es lo que sale en la notificacion del movil", () => {
  expect(fallbackText(t, msg({ text: "el catch no limpia" }))).toBe("Edu: el catch no limpia");
  expect(fallbackText(t, msg({ kind: "patch", text: "diff" }))).toContain("parche");
});

test("los bloques respetan el limite de 3000 caracteres de Slack, troceando", () => {
  const largo = "x".repeat(9000);
  const bloques = messageBlocks(t, msg({ text: largo })) as any[];
  for (const b of bloques) {
    const txt = b.text?.text ?? b.elements?.[0]?.text ?? "";
    expect(txt.length).toBeLessThanOrEqual(3000);
  }
  // Y no se pierde nada por el camino.
  const total = bloques.map(b => b.text?.text ?? "").join("").length;
  expect(total).toBeGreaterThanOrEqual(9000);
});

test("un mensaje largo no se corta a mitad de palabra", () => {
  const largo = Array.from({ length: 200 }, (_, i) => `linea ${i} con texto suficiente para llenar`).join("\n");
  const trozos = chunk(largo);
  for (const c of trozos) expect(c.length).toBeLessThanOrEqual(2800);
  // Nada se parte por dentro de una linea mientras quepa.
  expect(trozos.join("\n").startsWith("linea 0 con texto")).toBe(true);
});

test("una linea mas larga que un bloque se trocea, no se tira", () => {
  const trozos = chunk("x".repeat(7000));
  expect(trozos.join("").length).toBe(7000);
});

test("el texto viaja en los bloques y vuelve entero, sin depender del sobre", () => {
  const largo = Array.from({ length: 300 }, (_, i) => `linea ${i}`).join("\n");
  // fallbackText es corto a proposito: es la notificacion del movil, no el contenido.
  expect(fallbackText(t, msg({ text: largo })).length).toBeLessThan(300);
  // Lo que lee el demonio del otro lado son los bloques marcados.
  const bloques = messageBlocks(t, msg({ text: largo }));
  expect(bodyFromBlocks(bloques as any)).toBe(largo);
});

test("solo los bloques de contenido cuentan: la firma y los avisos no", () => {
  const bloques = messageBlocks(t, msg({ text: "el catch no limpia", offTopic: { verdict: "fuera", why: "x" } }));
  const cuerpo = bodyFromBlocks(bloques as any);
  expect(cuerpo).toBe("el catch no limpia");
  expect(cuerpo).not.toContain("su Claude");
  expect(cuerpo).not.toContain("vigilante");
});

test("la invitacion tambien se reconstruye desde sus bloques", () => {
  expect(bodyFromBlocks(inviteBlocks(t) as any)).toBe("se cierra antes del POST");
});

test("un acuse a secas es aceptar, no un turno de conversacion", () => {
  for (const s of ["acepto", "Acepto.", "vale", "ok", "dale", "👍", " sí "]) expect(esAcuse(s)).toBe(true);
  for (const s of ["acepto, pero mira antes el toaster", "ok el hook devuelve promesa", "vale la pena revisarlo"])
    expect(esAcuse(s)).toBe(false);
});

test("el mrkdwn de Slack se deshace: codigo que parecia una URL vuelve a ser codigo", () => {
  const bloques = [
    { type: "section", block_id: "sp-body-0-1", text: { type: "mrkdwn", text: "await <http://api.post|api.post>('/profile')" } },
    { type: "section", block_id: "sp-body-1-1", text: { type: "mrkdwn", text: "if (a &lt; b &amp;&amp; c &gt; d) {}" } },
  ];
  const cuerpo = bodyFromBlocks(bloques as any);
  expect(cuerpo).toContain("await api.post('/profile')");
  expect(cuerpo).toContain("if (a < b && c > d) {}");
  expect(cuerpo).not.toContain("http://");
});

test("el gasto de un equipo de 15 cabe en el limite de Slack", () => {
  // Se leen las constantes de verdad, no el texto del fichero: si alguien sube el
  // tope o acelera el descubrimiento, la cuenta tiene que salir mal aqui.
  const B = SlackBridge as any;
  const tope: number = B.TOPE_HILOS;

  // El limite Tier 3 es ~50/min por metodo y POR APP, o sea compartido por el equipo.
  const LIMITE = 50;
  const equipo = 15, activos = 2;
  const porMinuto = (cadaMs: number) => 60_000 / cadaMs;

  // conversations.history: una por ronda de descubrimiento y por persona, a la cadencia
  // que le toca a un equipo de 15. Los 15 demonios descubren a la vez, con o sin conversacion.
  const history = equipo * porMinuto(cadenciaDescubrir(equipo));
  // conversations.replies: un tick cada 4 s mirando como mucho TOPE_HILOS hilos,
  // pero una conversacion de dos solo tiene un hilo vivo por lado.
  const replies = activos * Math.min(1, tope) * porMinuto(4_000);

  expect(history).toBeLessThan(LIMITE);
  expect(replies).toBeLessThan(LIMITE);
  expect(tope).toBeLessThanOrEqual(4);
});

test("un parche que cabe no se corta por el camino", () => {
  const linea = "+ const x = 1;";
  const diff = Array(Math.floor(MAX_PARCHE / (linea.length + 1))).fill(linea).join("\n");
  const t = { id: "p1", subject: "x", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, state: "open", createdAt: 0, lastActivityAt: 0, context: {}, messages: [] } as any as Thread;
  const bloques = messageBlocks(t, { at: 0, from: "A", author: "claude", kind: "patch", text: diff });
  const texto = JSON.stringify(bloques);
  // El aviso de corte solo aparece si algo se quedo fuera, y lo que cabe no se queda fuera.
  expect(texto).not.toContain("sigue en el transcript");
});

test("el buzon se mira tan a menudo como el cupo de la app permita al equipo real", async () => {
  const { cadenciaDescubrir } = await import("../src/slack.ts");
  expect(cadenciaDescubrir(1)).toBe(5_000);
  expect(cadenciaDescubrir(2)).toBe(5_000);
  expect(cadenciaDescubrir(4)).toBe(9_600);
  expect(cadenciaDescubrir(15)).toBe(36_000);
  expect(cadenciaDescubrir(25)).toBe(60_000);
  // 25 demonios a esa cadencia gastan 25 llamadas por minuto, la mitad del cupo.
  expect(Math.round(25 * 60_000 / cadenciaDescubrir(25))).toBe(25);
});

test("un sobre con un id que no es un id no es un sobre", () => {
  const msg = (id: string) => ({ metadata: { event_type: EVENT, event_payload: { id, from: "U1", kind: "invite" } } });
  expect(envelopeOf(msg("../settings"))).toBeNull();
  expect(envelopeOf(msg("a/b"))).toBeNull();
  expect(envelopeOf(msg("x".repeat(40)))).toBeNull();
  expect(envelopeOf(msg("e856"))).not.toBeNull();
});

function puenteAbrir(fallaGrupo = false) {
  const llamadas: { method: string; body: any }[] = [];
  const b: any = new (SlackBridge as any)("xoxp-falso", "xoxb-falso", "U_EDU", async () => {}, async () => {}, async () => {});
  b.call = async (method: string, body: any) => {
    llamadas.push({ method, body });
    if (method === "conversations.open") {
      const users = String(body.users);
      if (users.includes(",")) { if (fallaGrupo) throw new Error("slack conversations.open: missing_scope"); return { channel: { id: "G_GRUPO" } }; }
      return { channel: { id: "D_SAM" } };
    }
    if (method === "chat.postMessage") return { ts: body.channel === "G_GRUPO" ? "200.000" : "201.000" };
    if (method === "chat.getPermalink") return { permalink: "https://x.slack.com/archives/G_GRUPO/p200000" };
    return {};
  };
  return { b, llamadas };
}

test("el hilo de un spoochie que abro va a un grupo que vemos los dos, y el DM del receptor recibe el aviso con el puntero", async () => {
  const Cfg = await import("../src/config.ts");
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_EDU", pollMs: 4000, hilos: "grupo" } } as any);
  const { b, llamadas } = puenteAbrir();
  const r = await b.openThread(t);
  // Y se guarda donde quedo el aviso del DM, para poder borrarlo al cerrar.
  expect(r).toEqual({ channel: "G_GRUPO", ts: "200.000", aviso: { channel: "D_SAM", ts: "201.000" } });
  const abiertos = llamadas.filter(l => l.method === "conversations.open").map(l => l.body.users);
  expect(abiertos).toContain("U_SAM");
  expect(abiertos).toContain("U_EDU,U_SAM");
  const posts = llamadas.filter(l => l.method === "chat.postMessage");
  expect(posts.map(p => p.body.channel)).toEqual(["G_GRUPO", "D_SAM"]);
  // El aviso del DM lleva el sobre completo y donde esta el hilo; el del grupo, no.
  expect(posts[0].body.metadata.event_payload.thread).toBeUndefined();
  expect(posts[1].body.metadata.event_payload.thread).toEqual({ channel: "G_GRUPO", ts: "200.000" });
  expect(flat(posts[1].body.blocks)).toContain("La conversacion sigue en");
  // Y el receptor materializa el hilo en el grupo, no en su DM.
  const env = envelopeOf({ metadata: { event_type: EVENT, event_payload: posts[1].body.metadata.event_payload } })!;
  expect(env.thread!.channel).toBe("G_GRUPO");
});

test("sin permisos para grupos, el hilo se queda en el DM del receptor, como antes", async () => {
  const Cfg = await import("../src/config.ts");
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_EDU", pollMs: 4000, hilos: "grupo" } } as any);
  const { b, llamadas } = puenteAbrir(true);
  const r = await b.openThread(t);
  expect(r).toEqual({ channel: "D_SAM", ts: "201.000" });
  expect(llamadas.filter(l => l.method === "chat.postMessage").length).toBe(1);
});

test("con --hilos canal, el hilo va al canal y el aviso al DM", async () => {
  const Cfg = await import("../src/config.ts");
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_EDU", pollMs: 4000, hilos: "canal", canal: "C_SPOOCHIE" } } as any);
  const { b, llamadas } = puenteAbrir();
  const r = await b.openThread(t);
  expect(r.channel).toBe("C_SPOOCHIE");
  expect(llamadas.filter(l => l.method === "chat.postMessage").map(l => l.body.channel)).toEqual(["C_SPOOCHIE", "D_SAM"]);
  Cfg.save({ guardian: false, transcript: false } as any);
});

test("el cierre viaja con su propio tipo y el otro lado cierra al leerlo", async () => {
  const b: any = new (SlackBridge as any)("xoxp-falso", "xoxb-falso", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "chat.postMessage") posts.push(body); return { ts: "1.0" }; };
  b.pensandoOff = async () => {};
  await b.post({ ...t, slack: { channel: "G1", ts: "0.1" }, closeReason: "resuelto" }, "[spoochie a3f1 | s] cerrado (resuelto). El tunel ya no entrega mensajes.");
  expect(posts[0].metadata.event_payload.kind).toBe("close");

  // Del otro lado: el sobre "close" llama a onCierre con el motivo, y no se entrega como turno.
  const entregados: any[] = [];
  const cerrados: string[] = [];
  const r: any = new (SlackBridge as any)("xoxp-falso", "xoxb-falso", "U_SAM", async (_t: any, m: any) => { entregados.push(m); }, async () => {}, async () => {});
  r.onCierre = async (_t: any, motivo: string) => { cerrados.push(motivo); };
  r.get = async () => ({ messages: [
    { ts: "0.1", user: "UBOT", text: "raiz" },
    { ts: "0.2", user: "UBOT", bot_id: "B1", text: "[spoochie a3f1 | s] cerrado (resuelto). x", metadata: { event_type: EVENT, event_payload: { v: 1, id: "a3f1", kind: "close", from: "U_EDU" } } },
  ] });
  const hilo = { ...t, slack: { channel: "G1", ts: "0.1" } };
  const Tm = await import("../src/threads.ts"); Tm.save(hilo as any);
  await r.pollThread(Tm.load("a3f1"));
  expect(cerrados).toEqual(["resuelto"]);
  expect(entregados).toEqual([]);
});

test("borrarHilo borra lo del bot (mensajes, ficheros, raiz y aviso) y deja lo que escribio una persona", async () => {
  const b: any = new (SlackBridge as any)("xoxp-falso", "xoxb-falso", "U_EDU", async () => {}, async () => {}, async () => {});
  b.botUserId = "UBOT";
  const borrados: string[] = [];
  b.get = async () => ({ messages: [
    { ts: "0.1", user: "UBOT", bot_id: "B1", text: "raiz" },
    { ts: "0.2", user: "UBOT", bot_id: "B1", text: "del bot", files: [{ id: "F1" }] },
    { ts: "0.3", user: "U_SAM", text: "escrito a mano" },
    { ts: "0.4", bot_id: "B1", text: "del bot otra vez" },
  ] });
  b.call = async (method: string, body: any) => { borrados.push(`${method}:${body.ts ?? body.file}`); return {}; };
  const n = await b.borrarHilo({ ...t, slack: { channel: "G1", ts: "0.1", aviso: { channel: "D_SAM", ts: "9.9" } } });
  expect(borrados).toEqual(["files.delete:F1", "chat.delete:0.2", "chat.delete:0.4", "chat.delete:0.1", "chat.delete:9.9"]);
  expect(n).toBe(4);
});

test("un hola por Slack trae la clave Nostr del otro y se guarda en la agenda; el mio lleva la mia", async () => {
  const b: any = new (SlackBridge as any)("xoxp-falso", "xoxb-falso", "U_EDU", async () => {}, async () => {}, async () => {});
  const posts: any[] = [];
  b.call = async (method: string, body: any) => { if (method === "conversations.open") return { channel: { id: "D_X" } }; if (method === "chat.postMessage") posts.push(body); return {}; };
  await b.hola("U_SAM", "a".repeat(64), ["wss://x"], "Edu");
  expect(posts[0].channel).toBe("D_X");
  expect(posts[0].metadata.event_payload).toMatchObject({ kind: "hola", np: "a".repeat(64), r: ["wss://x"], fromName: "Edu" });
  // Va firmado con mi clave ed25519: sin eso, cualquiera con el token del bot pone una clave a mi nombre.
  const { comprobar } = await import("../src/firma.ts");
  const p = posts[0].metadata.event_payload;
  expect(comprobar(p.pk, "hola", "hola", "U_EDU", p.np, p.sig)).toBe(true);
  expect(comprobar(p.pk, "hola", "hola", "U_EDU", "b".repeat(64), p.sig)).toBe(false);

  const recibidos: any[] = [];
  b.onHola = async (de: string, nombre: string, np: string, r: string[], veredicto: string) => { recibidos.push({ de, nombre, np, r, veredicto }); };
  b.inbox = async () => "D_ME";
  b.get = async () => ({ messages: [
    { ts: "5.0", metadata: { event_type: EVENT, event_payload: { v: 1, id: "hola", kind: "hola", from: "U_SAM", fromName: "Sam", np: "b".repeat(64), r: ["wss://sam"] } } },
    { ts: "5.0", metadata: { event_type: EVENT, event_payload: { v: 1, id: "hola", kind: "hola", from: "U_SAM", fromName: "Sam", np: "b".repeat(64), r: ["wss://sam"] } } },
  ] });
  b.inboxCursor = "0";
  await b.discover();
  expect(recibidos).toEqual([{ de: "U_SAM", nombre: "Sam", np: "b".repeat(64), r: ["wss://sam"], veredicto: "sin-firma" }]);
});
