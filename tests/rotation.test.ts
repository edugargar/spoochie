import { expect, test } from "bun:test";
import { newKeys, verifyEnvelope } from "../src/signing.ts";
import { signedRotation } from "../src/slack.ts";
import { incomingRotation } from "../src/keys.ts";
import * as Cfg from "../src/config.ts";

const conAgenda = (pk?: string) => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 }, contacts: { sam: { id: "U_SAM", name: "Sam", ...(pk ? { pk } : {}) } } });
  return Cfg.load();
};

test("una rotacion firmada con la clave vieja cambia la clave fijada", () => {
  const vieja = newKeys(), nueva = newKeys();
  const c = conAgenda(vieja.pub);
  const env = signedRotation("U_SAM", "U_YO", "Sam", nueva.pub, vieja.priv, vieja.pub);
  // El texto firmado es la clave nueva: sin eso, la firma no ata lo que se anuncia.
  const veredicto = verifyEnvelope(env as any, nueva.pub);
  expect(veredicto).toBe("ok");
  const r = incomingRotation(c, "U_SAM", nueva.pub, veredicto);
  expect(r.ok).toBe(true);
  expect(Cfg.contactById(c, "U_SAM")?.pk).toBe(nueva.pub);
});

test("firmada con otra clave, no", () => {
  const vieja = newKeys(), nueva = newKeys(), impostor = newKeys();
  const c = conAgenda(vieja.pub);
  const env = signedRotation("U_SAM", "U_YO", "Sam", nueva.pub, impostor.priv, impostor.pub);
  const veredicto = verifyEnvelope(env as any, nueva.pub);
  expect(veredicto).toBe("mala");
  expect(incomingRotation(c, "U_SAM", nueva.pub, veredicto).ok).toBe(false);
  expect(Cfg.contactById(c, "U_SAM")?.pk).toBe(vieja.pub);
});

test("de alguien sin clave fijada no se acepta una rotacion", () => {
  // Seria alguien de quien no sabiamos nada estrenandose con un cambio de clave. Se
  // para dos veces: por el veredicto ("nueva" no es "ok") y, por si acaso, mirando
  // que hubiera una clave que sustituir.
  const c = conAgenda();
  const porVeredicto = incomingRotation(c, "U_SAM", newKeys().pub, "nueva");
  expect(porVeredicto.ok).toBe(false);
  if (porVeredicto.ok) throw new Error("imposible");
  expect(porVeredicto.por).toContain("no cuadra con la clave fijada");

  const porFaltaDeClave = incomingRotation(c, "U_SAM", newKeys().pub, "ok");
  expect(porFaltaDeClave.ok).toBe(false);
  if (porFaltaDeClave.ok) throw new Error("imposible");
  expect(porFaltaDeClave.por).toContain("no tenia ninguna clave fijada");
});

test("una rotacion a la misma clave, o a algo que no es una clave, se rechaza", () => {
  const vieja = newKeys();
  const c = conAgenda(vieja.pub);
  expect(incomingRotation(c, "U_SAM", vieja.pub, "ok").ok).toBe(false);
  expect(incomingRotation(c, "U_SAM", "no", "ok").ok).toBe(false);
});

test("el aviso de rotacion se lee en el DM, no solo en el sobre", async () => {
  const slack = await Bun.file(new URL("../src/slack.ts", import.meta.url)).text();
  const f = slack.slice(slack.indexOf("async rotar("), slack.indexOf("onRota:"));
  // Si te robaron la clave vieja, el ladron tambien puede firmar la rotacion. Lo unico
  // que queda es que la persona lo vea escrito y pregunte por otro sitio.
  expect(f).toContain("preguntaselo por otro sitio");
});
