import { test, expect } from "bun:test";
import { newKeys, makeSignature, makeSignatureV1, checkSignature, checkSignatureV1, canon, verifyEnvelope, WINDOW_MS } from "../src/signing.ts";
import * as Cfg from "../src/config.ts";

const k = newKeys();
const ahora = () => Math.floor(Date.now() / 1000);
const D = (x: Partial<Parameters<typeof makeSignature>[1]> = {}) =>
  ({ id: "a1", kind: "msg", from: "U1", to: "U2", ts: ahora(), app: "0.9.9", ...x });

test("una firma valida se comprueba y una alterada no", () => {
  const d = D();
  const sig = makeSignature(k.priv, d, "hola");
  expect(checkSignature(k.pub, d, "hola", sig)).toBe(true);
  expect(checkSignature(k.pub, d, "hola.", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, from: "U9" }, "hola", sig)).toBe(false);
  expect(checkSignature(newKeys().pub, d, "hola", sig)).toBe(false);
});

test("la firma ata destinatario, hora, version, asunto e hilo, que antes viajaban fuera", () => {
  const d = D({ subject: "el modal", thread: { channel: "C1", ts: "1.1" } });
  const sig = makeSignature(k.priv, d, "hola");
  expect(checkSignature(k.pub, d, "hola", sig)).toBe(true);
  // Cada uno de estos campos se podia cambiar sin invalidar la firma de la v1.
  expect(checkSignature(k.pub, { ...d, to: "U9" }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, ts: d.ts + 1 }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, app: "0.9.7" }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, subject: "otra cosa" }, "hola", sig)).toBe(false);
  expect(checkSignature(k.pub, { ...d, thread: { channel: "C2", ts: "1.1" } }, "hola", sig)).toBe(false);
});

test("lo que Slack toca por el camino no rompe la firma", () => {
  const d = D();
  const sig = makeSignature(k.priv, d, "a & b <c> http://x.y/z\r\n");
  const llegado = "a &amp; b &lt;c&gt; <http://x.y/z>";
  expect(canon(llegado)).toBe("a & b <c> http://x.y/z");
  expect(checkSignature(k.pub, d, llegado, sig)).toBe(true);
});

const sobre = (x: any = {}, priv = k.priv, pub = k.pub) => {
  const d = { id: "t1", kind: "msg", from: "U_SAM", to: "U_YO", ts: ahora(), app: "0.9.9", ...x };
  return { ...d, fromName: "Sam", sv: 2, pk: pub, sig: makeSignature(priv, d, x.texto ?? "x") };
};

test("la primera clave de un id se fija, y otra distinta despues se rechaza", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  // Solo se fija la clave de alguien que ya esta en la agenda: le invite yo o me invito el.
  const c0 = Cfg.load(); Cfg.addContact(c0, { id: "U_SAM", name: "Sam" }); Cfg.save(c0);
  const env = sobre();
  expect(verifyEnvelope(env, "x")).toBe("nueva");
  expect(Cfg.contactById(Cfg.load(), "U_SAM")?.pk).toBe(k.pub);
  expect(verifyEnvelope(env, "x")).toBe("ok");
  const otra = newKeys();
  expect(verifyEnvelope(sobre({}, otra.priv, otra.pub), "x")).toBe("mala");
  expect(Cfg.contactById(Cfg.load(), "U_SAM")?.pk).toBe(k.pub);
});

test("un sobre guardado y vuelto a soltar caduca", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  const viejo = sobre({ ts: ahora() - Math.floor(WINDOW_MS / 1000) - 60 });
  expect(verifyEnvelope(viejo, "x")).toBe("caducada");
  // Del futuro tampoco: un reloj adelantado no da validez indefinida.
  expect(verifyEnvelope(sobre({ ts: ahora() + Math.floor(WINDOW_MS / 1000) + 60 }), "x")).toBe("caducada");
  // Y sin hora, tampoco.
  expect(verifyEnvelope(sobre({ ts: 0 }), "x")).toBe("caducada");
});

test("un sobre firmado para otra persona no vale en mi hilo", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  expect(verifyEnvelope(sobre({ to: "U_OTRO" }), "x")).toBe("ajena");
  expect(verifyEnvelope(sobre({ to: "U_YO" }), "x")).toBe("ok");
  // Un hola no va dirigido a un hilo y puede ir sin destinatario.
  expect(verifyEnvelope(sobre({ to: "" }), "x")).toBe("ok");
});

test("una firma de la v1 sigue valiendo, pero se marca como vieja", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  // Un sobre de 0.9.8: sin `sv`, y firmado solo sobre id, kind, from y el texto.
  const v1 = { id: "t1", kind: "msg", from: "U_SAM", fromName: "Sam", pk: k.pub, sig: makeSignatureV1(k.priv, "t1", "msg", "U_SAM", "x") };
  expect(checkSignatureV1(k.pub, "t1", "msg", "U_SAM", "x", v1.sig)).toBe(true);
  expect(verifyEnvelope(v1, "x")).toBe("vieja");
  // Y una v1 alterada sigue siendo mala.
  expect(verifyEnvelope({ ...v1, from: "U_OTRO" }, "x")).toBe("mala");
});

test("un sobre sin firma se marca, no se descarta", () => {
  expect(verifyEnvelope({ id: "t2", kind: "msg", from: "U_X" }, "x")).toBe("sin-firma");
});

test("la clave de la invitacion queda en la agenda con el nombre", () => {
  const c: Cfg.Config = { guardian: false, transcript: false };
  Cfg.addContact(c, { id: "U_EDU", name: "Edu", pk: "PK1" });
  Cfg.addContact(c, { id: "U_EDU", name: "Edu" });
  expect(Cfg.contact(c, "edu")?.pk).toBe("PK1");
});

test("quitarle la firma a un sobre no lo cuela: atacar es no firmar", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  // De un desconocido, un sobre sin firma entra marcado: puede ser una version vieja.
  expect(verifyEnvelope({ id: "t9", kind: "msg", from: "U_NADIE" }, "x")).toBe("sin-firma");
  // En cuanto tengo su clave fijada, un sobre suyo sin firma es un ataque, no una version vieja.
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_NADIE", name: "Nadie", pk: k.pub }); Cfg.save(c);
  expect(verifyEnvelope({ id: "t9", kind: "msg", from: "U_NADIE" }, "x")).toBe("degradada");
});

test("un sobre bien firmado de un id que no esta en tu agenda no fija ninguna clave", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  // Quien pueda postear con el token del bot puede inventarse un id. Antes, verificarSobre
  // le daba de alta con el nombre que el mismo dijera solo por verle escribir una vez.
  expect(verifyEnvelope(sobre({ from: "U_INTRUSO" }), "x")).toBe("desconocida");
  expect(Cfg.contactById(Cfg.load(), "U_INTRUSO")).toBeNull();
});

/**
 * `kindOfMsg` viajaba fuera de la firma, y decide si el vigilante mira el mensaje: se
 * saltaba todo lo que no fuera "text". O sea que mover una palabra que nadie firmaba
 * apagaba el vigilante para ese mensaje, sin tocar el texto ni romper la firma.
 *
 * Entra en la v2 sin romper a nadie: la v2 no ha salido en ninguna version publicada (la
 * ultima es la 0.9.8 y firma con la v1).
 */
test("mover kindOfMsg invalida la firma", () => {
  const k = newKeys();
  const c = Cfg.load();
  c.slack = { userId: "U_ME" } as any;
  Cfg.addContact(c, { id: "U_KOM", name: "Ana", pk: k.pub } as any);
  Cfg.save(c);
  const env: any = { id: "kom", kind: "msg", from: "U_KOM", to: "U_ME", ts: Math.floor(Date.now() / 1000), sv: 2, app: "0.9.9", pk: k.pub, kindOfMsg: "text" };
  env.sig = makeSignature(k.priv, env, "mira esto");
  expect(verifyEnvelope(env, "mira esto")).toBe("ok");
  expect(verifyEnvelope({ ...env, kindOfMsg: "patch" }, "mira esto")).toBe("mala");
  // Y quitarlo del todo tampoco cuela: se firma "" y "text" no es "".
  expect(verifyEnvelope({ ...env, kindOfMsg: undefined }, "mira esto")).toBe("mala");
});
