import { test, expect } from "bun:test";
import { limpiarCadena, leerInvitacion } from "../src/alta.ts";

// Una invitacion vale por las claves publicas de quien invita, no por ningun secreto.
const YO = { id: "U0EDU001", name: "Edu", np: "a".repeat(64) };
const blob = Buffer.from(JSON.stringify({ t: "Equipo", i: YO })).toString("base64url");

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

test("la invitacion trae la clave de quien invita, y ningun secreto", () => {
  expect(leerInvitacion(blob)?.i?.np).toBe("a".repeat(64));
  expect(leerInvitacion(blob)?.t).toBe("Equipo");
  expect(Buffer.from(blob, "base64url").toString()).not.toContain("xoxb-");
});

test("lo que no es una invitacion no cuela", () => {
  expect(leerInvitacion("no-es-base64-de-nada")).toBeNull();
  expect(leerInvitacion(Buffer.from(JSON.stringify({ t: "Equipo" })).toString("base64url"))).toBeNull();
  // Un token suelto ya no hace valida una cadena: sin clave Nostr no es una invitacion.
  expect(leerInvitacion(Buffer.from(JSON.stringify({ b: "xoxb-" + "z".repeat(40) })).toString("base64url"))).toBeNull();
});

import { crearInvitacion, textoInvitacion } from "../src/alta.ts";
import * as Cfg from "../src/config.ts";

test("la invitacion dirigida lleva para quien es y quien invita, y sobrevive al pegado", () => {
  const blob = crearInvitacion({ t: "Equipo", u: "U0SAM001", n: "Sam", i: YO });
  const leida = leerInvitacion(limpiarCadena(textoInvitacion(blob, "Edu"))!);
  expect(leida?.u).toBe("U0SAM001");
  expect(leida?.n).toBe("Sam");
  expect(leida?.i).toEqual({ id: "U0EDU001", name: "Edu", np: "a".repeat(64) });
});

test("un destinatario que no parece un id de Slack se ignora", () => {
  const blob = crearInvitacion({ i: YO, u: "../etc" as any });
  expect(leerInvitacion(blob)?.u).toBeUndefined();
});

test("el DM lleva los cuatro pasos y la cadena entera", () => {
  const blob = crearInvitacion({ i: YO });
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

test("no hay forma de meter el token del bot en una invitacion", async () => {
  const { datosInvitacion, crearInvitacion, leerInvitacion, textoInvitacion } = await import("../src/alta.ts");
  const yo = { id: "U0EDU001", name: "Edu", np: "a".repeat(64), r: ["wss://x"] };
  const inv = datosInvitacion({ team: "Equipo", dest: { id: "U0SAM001", name: "Sam" }, yo });
  expect(inv.u).toBe("U0SAM001");
  expect(inv.i?.np).toBe("a".repeat(64));
  // Cualquiera abre la cadena con un decodificador de base64: dentro no hay token, y ya
  // no queda ninguna bandera que lo vuelva a meter. Antes la habia: --con-slack.
  const blob = crearInvitacion(inv);
  const dentro = Buffer.from(blob, "base64url").toString();
  expect(dentro).not.toContain("xoxb-");
  expect(dentro).not.toContain("xoxp-");
  expect(JSON.parse(dentro).b).toBeUndefined();
  expect(leerInvitacion(blob)?.u).toBe("U0SAM001");
  expect(textoInvitacion(blob, "Edu")).toContain("No hay ninguna contrasena dentro");
  expect(textoInvitacion(blob, "Edu")).not.toContain("token");
});

test("una invitacion vieja con token dentro se lee, pero el token se tira y se dice", async () => {
  const { crearInvitacion, leerInvitacion } = await import("../src/alta.ts");
  // Lo que mandaba `spoochie invite --con-slack` hasta 0.9.8.
  const vieja = crearInvitacion({ t: "Equipo", u: "U0SAM001", i: YO, ...({ b: "xoxb-" + "z".repeat(40) } as any) });
  const leida = leerInvitacion(vieja);
  expect(leida?.u).toBe("U0SAM001");
  expect(leida?.traiaToken).toBe(true);
  expect(JSON.stringify(leida)).not.toContain("xoxb-");
});
