import { test, expect } from "bun:test";
import { nuevasClaves, firmar, firmarV1, comprobar, comprobarV1, canon, verificarSobre, VENTANA_MS } from "../src/firma.ts";
import * as Cfg from "../src/config.ts";

const k = nuevasClaves();
const ahora = () => Math.floor(Date.now() / 1000);
const D = (x: Partial<Parameters<typeof firmar>[1]> = {}) =>
  ({ id: "a1", kind: "msg", from: "U1", to: "U2", ts: ahora(), app: "0.9.9", ...x });

test("una firma valida se comprueba y una alterada no", () => {
  const d = D();
  const sig = firmar(k.priv, d, "hola");
  expect(comprobar(k.pub, d, "hola", sig)).toBe(true);
  expect(comprobar(k.pub, d, "hola.", sig)).toBe(false);
  expect(comprobar(k.pub, { ...d, from: "U9" }, "hola", sig)).toBe(false);
  expect(comprobar(nuevasClaves().pub, d, "hola", sig)).toBe(false);
});

test("la firma ata destinatario, hora, version, asunto e hilo, que antes viajaban fuera", () => {
  const d = D({ subject: "el modal", thread: { channel: "C1", ts: "1.1" } });
  const sig = firmar(k.priv, d, "hola");
  expect(comprobar(k.pub, d, "hola", sig)).toBe(true);
  // Cada uno de estos campos se podia cambiar sin invalidar la firma de la v1.
  expect(comprobar(k.pub, { ...d, to: "U9" }, "hola", sig)).toBe(false);
  expect(comprobar(k.pub, { ...d, ts: d.ts + 1 }, "hola", sig)).toBe(false);
  expect(comprobar(k.pub, { ...d, app: "0.9.7" }, "hola", sig)).toBe(false);
  expect(comprobar(k.pub, { ...d, subject: "otra cosa" }, "hola", sig)).toBe(false);
  expect(comprobar(k.pub, { ...d, thread: { channel: "C2", ts: "1.1" } }, "hola", sig)).toBe(false);
});

test("lo que Slack toca por el camino no rompe la firma", () => {
  const d = D();
  const sig = firmar(k.priv, d, "a & b <c> http://x.y/z\r\n");
  const llegado = "a &amp; b &lt;c&gt; <http://x.y/z>";
  expect(canon(llegado)).toBe("a & b <c> http://x.y/z");
  expect(comprobar(k.pub, d, llegado, sig)).toBe(true);
});

const sobre = (x: any = {}, priv = k.priv, pub = k.pub) => {
  const d = { id: "t1", kind: "msg", from: "U_SAM", to: "U_YO", ts: ahora(), app: "0.9.9", ...x };
  return { ...d, fromName: "Sam", sv: 2, pk: pub, sig: firmar(priv, d, x.texto ?? "x") };
};

test("la primera clave de un id se fija, y otra distinta despues se rechaza", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const env = sobre();
  expect(verificarSobre(env, "x")).toBe("nueva");
  expect(Cfg.contactById(Cfg.load(), "U_SAM")?.pk).toBe(k.pub);
  expect(verificarSobre(env, "x")).toBe("ok");
  const otra = nuevasClaves();
  expect(verificarSobre(sobre({}, otra.priv, otra.pub), "x")).toBe("mala");
  expect(Cfg.contactById(Cfg.load(), "U_SAM")?.pk).toBe(k.pub);
});

test("un sobre guardado y vuelto a soltar caduca", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  const viejo = sobre({ ts: ahora() - Math.floor(VENTANA_MS / 1000) - 60 });
  expect(verificarSobre(viejo, "x")).toBe("caducada");
  // Del futuro tampoco: un reloj adelantado no da validez indefinida.
  expect(verificarSobre(sobre({ ts: ahora() + Math.floor(VENTANA_MS / 1000) + 60 }), "x")).toBe("caducada");
  // Y sin hora, tampoco.
  expect(verificarSobre(sobre({ ts: 0 }), "x")).toBe("caducada");
});

test("un sobre firmado para otra persona no vale en mi hilo", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  expect(verificarSobre(sobre({ to: "U_OTRO" }), "x")).toBe("ajena");
  expect(verificarSobre(sobre({ to: "U_YO" }), "x")).toBe("ok");
  // Un hola no va dirigido a un hilo y puede ir sin destinatario.
  expect(verificarSobre(sobre({ to: "" }), "x")).toBe("ok");
});

test("una firma de la v1 sigue valiendo, pero se marca como vieja", () => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 } });
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_SAM", name: "Sam", pk: k.pub }); Cfg.save(c);
  // Un sobre de 0.9.8: sin `sv`, y firmado solo sobre id, kind, from y el texto.
  const v1 = { id: "t1", kind: "msg", from: "U_SAM", fromName: "Sam", pk: k.pub, sig: firmarV1(k.priv, "t1", "msg", "U_SAM", "x") };
  expect(comprobarV1(k.pub, "t1", "msg", "U_SAM", "x", v1.sig)).toBe(true);
  expect(verificarSobre(v1, "x")).toBe("vieja");
  // Y una v1 alterada sigue siendo mala.
  expect(verificarSobre({ ...v1, from: "U_OTRO" }, "x")).toBe("mala");
});

test("un sobre sin firma se marca, no se descarta", () => {
  expect(verificarSobre({ id: "t2", kind: "msg", from: "U_X" }, "x")).toBe("sin-firma");
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
  expect(verificarSobre({ id: "t9", kind: "msg", from: "U_NADIE" }, "x")).toBe("sin-firma");
  // En cuanto tengo su clave fijada, un sobre suyo sin firma es un ataque, no una version vieja.
  const c = Cfg.load(); Cfg.addContact(c, { id: "U_NADIE", name: "Nadie", pk: k.pub }); Cfg.save(c);
  expect(verificarSobre({ id: "t9", kind: "msg", from: "U_NADIE" }, "x")).toBe("degradada");
});
