import { test, expect } from "bun:test";
import { newKeys } from "../src/signing.ts";
import { cleanString, readInvite, createInvite, inviteData } from "../src/join.ts";

// Una invitacion vale por las claves publicas de quien invita, no por ningun secreto.
const YO = { id: "U0EDU001", name: "Edu", np: "a".repeat(64) };
const blob = Buffer.from(JSON.stringify({ t: "Equipo", i: YO })).toString("base64url");

test("la cadena se saca del comando entero pegado", () => {
  expect(cleanString(`spoochie join ${blob} --email ana@example.com`)).toBe(blob);
});

test("la cadena se saca de la barra del plugin y de las comillas de Slack", () => {
  expect(cleanString("/spoochie:join `" + blob + "`")).toBe(blob);
});

test("la cadena suelta vale tal cual", () => {
  expect(cleanString(blob)).toBe(blob);
});

test("sin cadena no se inventa una", () => {
  expect(cleanString("spoochie join --email ana@example.com")).toBeNull();
  expect(cleanString("")).toBeNull();
});

test("una bandera larga no se confunde con la cadena", () => {
  expect(cleanString(`--${"x".repeat(60)} ${blob}`)).toBe(blob);
});

test("la invitacion trae la clave de quien invita, y ningun secreto", () => {
  expect(readInvite(blob)?.i?.np).toBe("a".repeat(64));
  expect(readInvite(blob)?.t).toBe("Equipo");
  expect(Buffer.from(blob, "base64url").toString()).not.toContain("xoxb-");
});

test("lo que no es una invitacion no cuela", () => {
  expect(readInvite("no-es-base64-de-nada")).toBeNull();
  expect(readInvite(Buffer.from(JSON.stringify({ t: "Equipo" })).toString("base64url"))).toBeNull();
  // Un token suelto ya no hace valida una cadena: sin clave Nostr no es una invitacion.
  expect(readInvite(Buffer.from(JSON.stringify({ b: "xoxb-" + "z".repeat(40) })).toString("base64url"))).toBeNull();
});

import { createInvite, inviteText } from "../src/join.ts";
import * as Cfg from "../src/config.ts";

test("la invitacion dirigida lleva para quien es y quien invita, y sobrevive al pegado", () => {
  const blob = createInvite({ t: "Equipo", u: "U0SAM001", n: "Sam", i: YO });
  const leida = readInvite(cleanString(inviteText(blob, "Edu"))!);
  expect(leida?.u).toBe("U0SAM001");
  expect(leida?.n).toBe("Sam");
  expect(leida?.i).toEqual({ id: "U0EDU001", name: "Edu", np: "a".repeat(64) });
});

test("un destinatario que no parece un id de Slack se ignora", () => {
  const blob = createInvite({ i: YO, u: "../etc" as any });
  expect(readInvite(blob)?.u).toBeUndefined();
});

test("el DM lleva los cuatro pasos y la cadena entera", () => {
  const blob = createInvite({ i: YO });
  const t = inviteText(blob, "Edu");
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
  const { inviteData, createInvite, readInvite, inviteText } = await import("../src/join.ts");
  const yo = { id: "U0EDU001", name: "Edu", np: "a".repeat(64), r: ["wss://x"] };
  const inv = inviteData({ team: "Equipo", dest: { id: "U0SAM001", name: "Sam" }, yo });
  expect(inv.u).toBe("U0SAM001");
  expect(inv.i?.np).toBe("a".repeat(64));
  // Cualquiera abre la cadena con un decodificador de base64: dentro no hay token, y ya
  // no queda ninguna bandera que lo vuelva a meter. Antes la habia: --con-slack.
  const blob = createInvite(inv);
  const dentro = Buffer.from(blob, "base64url").toString();
  expect(dentro).not.toContain("xoxb-");
  expect(dentro).not.toContain("xoxp-");
  expect(JSON.parse(dentro).b).toBeUndefined();
  expect(readInvite(blob)?.u).toBe("U0SAM001");
  expect(inviteText(blob, "Edu")).toContain("No hay ninguna contrasena dentro");
  expect(inviteText(blob, "Edu")).not.toContain("token");
});

test("una invitacion vieja con token dentro se lee, pero el token se tira y se dice", async () => {
  const { createInvite, readInvite } = await import("../src/join.ts");
  // Lo que mandaba `spoochie invite --con-slack` hasta 0.9.8.
  const vieja = createInvite({ t: "Equipo", u: "U0SAM001", i: YO, ...({ b: "xoxb-" + "z".repeat(40) } as any) });
  const leida = readInvite(vieja);
  expect(leida?.u).toBe("U0SAM001");
  expect(leida?.traiaToken).toBe(true);
  expect(JSON.stringify(leida)).not.toContain("xoxb-");
});

/**
 * La costura entre las dos mitades del alta.
 *
 * El nonce de un solo uso tenia sus tests (`claves.test.ts`) y la cadena tenia los suyos,
 * pero nadie probaba el viaje entero: `leerInvitacion` no copiaba `k`, asi que `join`
 * mandaba el hola con el nonce a undefined y del otro lado `canjearInvitacion` devolvia
 * null. El hola de alguien nuevo caia siempre en "sin invitacion valida y clave
 * desconocida" y el alta por Nostr no funcionaba: habia que anadir a mano con `--npub`,
 * que es el camino de repuesto, no el normal.
 */
test("el nonce sobrevive el viaje entero: se apunta al invitar, viaja en la cadena y se canjea", async () => {
  const { newInvite, redeemInvite } = await import("../src/keys.ts");
  const c: any = {};
  const k = newInvite(c, { id: "U_SAM", name: "Sam" }, 1000);

  const blob = createInvite(inviteData({
    team: "Equipo", dest: { id: "U_SAM", name: "Sam" },
    yo: { id: "U_EDU", name: "Edu", np: "a".repeat(64), r: ["wss://uno"] }, k,
  }));
  const leida = readInvite(blob);
  expect(leida?.k).toBe(k);
  // Y con ese nonce, quien invito reconoce a quien entra.
  expect(redeemInvite(c, leida!.k, 2000)).toEqual({ id: "U_SAM", name: "Sam" });
});

test("lo que viene en la cadena tiene forma y tamano, o no entra", () => {
  const base = (i: any) => readInvite(createInvite({ i: { np: "b".repeat(64), ...i } } as any));
  // El nombre acaba en la agenda y en el titular del aviso: quien invita no elige cuanto ocupa.
  expect(base({ id: "U1", name: "N".repeat(5000) })?.i?.name.length).toBe(60);
  // La clave ed25519 es un SPKI en base64. Una cadena cualquiera se fijaba igual, y a
  // partir de ahi todo sobre firmado de esa persona daba "mala" sin que nadie supiera por que.
  expect(base({ id: "U1", name: "x", pk: "no soy una clave" })?.i?.pk).toBeUndefined();
  expect(base({ id: "U1", name: "x", pk: newKeys().pub })?.i?.pk).toBeString();
  // Y un nonce que no tiene forma de nonce tampoco viaja.
  expect(readInvite(createInvite({ k: "corto", i: { id: "U1", name: "x", np: "b".repeat(64) } } as any))?.k).toBeUndefined();
});
