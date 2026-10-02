import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Los dos sobres que hacen algo ellos solos: `accept` y `close`.
 *
 * El resto de un hilo lo lee una persona. Estos dos no: `accept` abre el tunel y lanza
 * el Claude aparte, y `close` cierra el spoochie y purga lo que hubiera guardado. Se
 * atendian ANTES de mirar la firma, y por Slack los dos lados postean con el mismo token
 * de bot, asi que quien tuviera ese token podia abrir o cerrar tuneles haciendose pasar
 * por la otra persona. Es exactamente el atacante para el que existe la firma, y esta
 * escrito asi en docs/PROTOCOL.md.
 *
 * Medido antes de tocar nada, con `pollThread` y un Slack de mentira: un sobre sin `sig`
 * ni `pk` con `from` ajeno daba aceptado=true con kind=accept y cerraba el hilo con
 * kind=close.
 */
// El HOME lo fija tests/setup.ts antes de que nadie importe paths.ts, y ROOT se
// calcula una sola vez al importarlo. Poner aqui otro SPOOCHIE_HOME no mueve ROOT: solo
// deja la config escrita donde nadie la lee. Se escribe en el ROOT que ya hay.
let HOME = "";

let SlackBridge: any, EVENT: string, T: any, firmar: any, nuevasClaves: any, Cfg: any;

const OTRO = "U_OTRO", YO = "U_ME", SIN_CLAVE = "U_BEA";
let claveOtro: { pub: string; priv: string };

beforeAll(async () => {
  HOME = (await import("../src/paths.ts")).ROOT;
  mkdirSync(join(HOME, "threads"), { recursive: true, mode: 0o700 });
  ({ newKeys: nuevasClaves, makeSignature: firmar } = await import("../src/signing.ts"));
  claveOtro = nuevasClaves();
  writeFileSync(join(HOME, "config.json"), JSON.stringify({
    guardian: false, transcript: false, aparte: false, human: "Edu",
    slack: { userId: YO, botToken: "xoxb-de-mentira" },
    // El otro lado esta en la agenda y con su clave ya fijada: es el caso normal.
    contacts: {
      ana: { id: OTRO, name: "Ana", pk: claveOtro.pub },
      // Bea esta en la agenda pero nunca ha firmado nada: no tengo clave suya.
      bea: { id: SIN_CLAVE, name: "Bea" },
    },
  }), { mode: 0o600 });
  ({ SlackBridge, EVENT } = await import("../src/slack.ts"));
  T = await import("../src/threads.ts");
  Cfg = await import("../src/config.ts");
});

/** Un puente con Slack de mentira, y lo que le llega del hilo. */
function puente(reply: any) {
  const hecho = { aceptado: false, cerrado: "", avisos: [] as string[] };
  const b = SlackBridge.fromConfig(
    async () => {}, async () => {}, async () => { hecho.aceptado = true; },
  )!;
  b.onCierre = async (_t: any, m: string) => { hecho.cerrado = m; };
  b.get = async (m: string) => m === "conversations.replies" ? { ok: true, messages: [reply] } : { ok: true };
  b.call = async (_m: string, body: any) => { hecho.avisos.push(String(body?.text ?? "")); return { ok: true, ts: "9.0" }; };
  return { b, hecho };
}

function hilo(id: string) {
  const t: any = {
    id, subject: "s", state: "pending", createdAt: Date.now(), lastActivityAt: Date.now(),
    from: { sessionId: `slack:${OTRO}`, name: "Ana", cwd: "(otra)", human: "Ana", slackUser: OTRO },
    to: { sessionId: `slack:${YO}`, name: "yo", cwd: "(esta)", slackUser: YO },
    context: {}, messages: [], slack: { channel: "C1", ts: "1.0" },
  };
  T.save(t);
  return t;
}

const TEXTO = "cerrado (por Ana)";
const sobre = (id: string, kind: string, extra: any = {}) => ({
  ts: "2.0", text: TEXTO,
  metadata: { event_type: EVENT, event_payload: { v: 1, id, kind, from: OTRO, fromName: "Ana", ...extra } },
});
/** Firmado como lo firma el emisor de verdad: sobre el cuerpo que reconstruye el receptor. */
function firmado(id: string, kind: string) {
  const env: any = { v: 1, id, kind, from: OTRO, to: YO, ts: Math.floor(Date.now() / 1000), sv: 2, app: "0.9.9", pk: claveOtro.pub };
  env.sig = firmar(claveOtro.priv, env, TEXTO);
  return sobre(id, kind, env);
}

test("un accept sin firma de quien ya tiene clave fijada no abre el tunel", async () => {
  hilo("s1");
  const { b, hecho } = puente(sobre("s1", "accept"));
  await b.pollThread(T.load("s1"));
  expect(hecho.aceptado).toBe(false);
  expect(hecho.avisos.join(" ")).toContain("Descartado");
});

/**
 * El caso que abre el agujero de verdad. Un sobre sin firma de un id del que no tengo
 * clave se ENTREGA, marcado como sin firmar: es la regla escrita en docs/PROTOCOL.md, y
 * para un mensaje esta bien, porque quien lo lee es una persona que ve la marca. Un
 * `accept` no lo lee nadie. Aqui "no rechazada" no basta: hace falta firma.
 */
test("y un accept sin firma de quien no tiene clave fijada tampoco, aunque un mensaje suyo si entraria", async () => {
  const t: any = hilo("s1b");
  t.from = { sessionId: `slack:${SIN_CLAVE}`, name: "Bea", cwd: "(otra)", human: "Bea", slackUser: SIN_CLAVE };
  T.save(t);
  const rep = sobre("s1b", "accept");
  rep.metadata.event_payload.from = SIN_CLAVE;
  const { b, hecho } = puente(rep);
  await b.pollThread(T.load("s1b"));
  expect(hecho.aceptado).toBe(false);
  expect(hecho.avisos.join(" ")).toContain("sin firmar");
});

test("un close sin firma no cierra ni purga el hilo", async () => {
  hilo("s2");
  const { b, hecho } = puente(sobre("s2", "close"));
  await b.pollThread(T.load("s2"));
  expect(hecho.cerrado).toBe("");
  expect(T.load("s2").state).toBe("pending");
});

test("una firma que no es de esa clave tampoco vale", async () => {
  hilo("s3");
  const otra = nuevasClaves();
  const env: any = { v: 1, id: "s3", kind: "accept", from: OTRO, to: YO, ts: Math.floor(Date.now() / 1000), sv: 2, pk: claveOtro.pub };
  env.sig = firmar(otra.priv, env, TEXTO);   // firmado con una clave que no es la suya
  const { b, hecho } = puente(sobre("s3", "accept", env));
  await b.pollThread(T.load("s3"));
  expect(hecho.aceptado).toBe(false);
});

test("y el accept firmado de verdad si abre el tunel", async () => {
  hilo("s4");
  const { b, hecho } = puente(firmado("s4", "accept"));
  await b.pollThread(T.load("s4"));
  expect(hecho.aceptado).toBe(true);
});

test("y el close firmado de verdad si cierra", async () => {
  hilo("s5");
  const { b, hecho } = puente(firmado("s5", "close"));
  await b.pollThread(T.load("s5"));
  expect(hecho.cerrado).toBe("por Ana");
});

/**
 * La firma v1 no vale para abrir ni cerrar.
 *
 * No firma ni la hora ni el destinatario, asi que un sobre suyo vale para siempre y en
 * cualquier hilo. Y no rompe compatibilidad con nadie: comprobado en el arbol de la
 * 0.9.8, `post` solo firmaba la invitacion y los mensajes, nunca un accept ni un close.
 */
test("una firma de la v1 no abre el tunel aunque sea valida", async () => {
  const { makeSignatureV1 } = await import("../src/signing.ts");
  hilo("s6");
  const env: any = { v: 1, id: "s6", kind: "accept", from: OTRO, fromName: "Ana", pk: claveOtro.pub };
  env.sig = makeSignatureV1(claveOtro.priv, "s6", "accept", OTRO, TEXTO);
  const { b, hecho } = puente(sobre("s6", "accept", env));
  await b.pollThread(T.load("s6"));
  expect(hecho.aceptado).toBe(false);
});
