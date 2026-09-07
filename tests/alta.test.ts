import { test, expect } from "bun:test";
import { limpiarCadena, leerInvitacion } from "../src/alta.ts";

const blob = Buffer.from(JSON.stringify({ b: "xoxb-" + "z".repeat(40), t: "Equipo" })).toString("base64url");

test("la cadena se saca del comando entero pegado", () => {
  expect(limpiarCadena(`spoochie join ${blob} --email ana@example.com`)).toBe(blob);
});

test("la cadena se saca de la barra del plugin y de las comillas de Slack", () => {
  expect(limpiarCadena("/spoochie:join `" + blob + "`")).toBe(blob);
});

test("la cadena suelta vale tal cual", () => {
  expect(limpiarCadena(blob)).toBe(blob);
});

test("sin cadena no se inventa una", () => {
  expect(limpiarCadena("spoochie join --email ana@example.com")).toBeNull();
  expect(limpiarCadena("")).toBeNull();
});

test("una bandera larga no se confunde con la cadena", () => {
  expect(limpiarCadena(`--${"x".repeat(60)} ${blob}`)).toBe(blob);
});

test("la invitacion trae el token del bot", () => {
  expect(leerInvitacion(blob)?.b).toStartWith("xoxb-");
  expect(leerInvitacion(blob)?.t).toBe("Equipo");
});

test("lo que no es una invitacion no cuela", () => {
  expect(leerInvitacion("no-es-base64-de-nada")).toBeNull();
  expect(leerInvitacion(Buffer.from(JSON.stringify({ t: "Equipo" })).toString("base64url"))).toBeNull();
});

import { crearInvitacion, textoInvitacion } from "../src/alta.ts";
import * as Cfg from "../src/config.ts";

test("la invitacion dirigida lleva para quien es y quien invita, y sobrevive al pegado", () => {
  const blob = crearInvitacion({ b: "xoxb-" + "z".repeat(40), t: "Equipo", u: "U0SAM001", n: "Sam", i: { id: "U0EDU001", name: "Edu" } });
  const leida = leerInvitacion(limpiarCadena(textoInvitacion(blob, "Edu"))!);
  expect(leida?.u).toBe("U0SAM001");
  expect(leida?.n).toBe("Sam");
  expect(leida?.i).toEqual({ id: "U0EDU001", name: "Edu" });
});

test("un destinatario que no parece un id de Slack se ignora", () => {
  const blob = crearInvitacion({ b: "xoxb-" + "z".repeat(40), u: "../etc" as any });
  expect(leerInvitacion(blob)?.u).toBeUndefined();
});

test("el DM lleva los cuatro pasos y la cadena entera", () => {
  const blob = crearInvitacion({ b: "xoxb-" + "z".repeat(40) });
  const t = textoInvitacion(blob, "Edu");
  expect(t).toContain("/plugin marketplace add edugargar/spoochie");
  expect(t).toContain("/plugin install spoochie@edugargar");
  expect(t).toContain(`/spoochie:join ${blob}`);
});

test("la agenda resuelve @nombre sin distinguir mayusculas ni espacios", () => {
  const c: Cfg.Config = { guardian: true, transcript: false };
  Cfg.addContact(c, { id: "U0EDU001", name: "Edu Garcia" });
  expect(Cfg.contact(c, "edugarcia")?.id).toBe("U0EDU001");
  expect(Cfg.contact(c, "EduGarcia")?.id).toBe("U0EDU001");
  expect(Cfg.contact(c, "sam")).toBeNull();
});

test("la invitacion por Slack no lleva el token del bot salvo que se pida, y el texto lo dice", async () => {
  const { datosInvitacion, crearInvitacion, leerInvitacion, textoInvitacion } = await import("../src/alta.ts");
  const yo = { id: "U0EDU001", name: "Edu", np: "a".repeat(64), r: ["wss://x"] };
  const sin = datosInvitacion({ bot: "xoxb-" + "z".repeat(40), team: "Equipo", dest: { id: "U0SAM001", name: "Sam" }, yo });
  expect(sin.b).toBeUndefined();
  expect(sin.u).toBe("U0SAM001");
  expect(sin.i?.np).toBe("a".repeat(64));
  // Cualquiera abre la cadena con un decodificador de base64: dentro no hay token.
  const blob = crearInvitacion(sin);
  expect(Buffer.from(blob, "base64url").toString()).not.toContain("xoxb-");
  expect(leerInvitacion(blob)?.u).toBe("U0SAM001");
  expect(textoInvitacion(blob, "Edu")).toContain("No hay ninguna contrasena dentro");
  const con = datosInvitacion({ bot: "xoxb-" + "z".repeat(40), team: "Equipo", dest: { id: "U0SAM001", name: "Sam" }, yo, conSlack: true });
  expect(con.b).toStartWith("xoxb-");
  expect(textoInvitacion(crearInvitacion(con), "Edu", undefined, true)).toContain("lleva el token del bot");
});
