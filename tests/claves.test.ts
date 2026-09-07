import { expect, test } from "bun:test";
import * as Cfg from "../src/config.ts";
import { nuevaInvitacion, canjearInvitacion, vincularClave, holaPorNostr, holaPorSlack, INVITACION_CADUCA_MS } from "../src/claves.ts";

const cfg = (): Cfg.Config => ({ guardian: false, transcript: false } as any);
const K_SAM = "a".repeat(64), K_X = "f".repeat(64), K_BEA = "b".repeat(64);

test("una invitacion se canjea una sola vez y caduca a los 30 dias", () => {
  const c = cfg();
  const k = nuevaInvitacion(c, { id: "U_SAM", name: "Sam" }, 1000);
  expect(k).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(canjearInvitacion(c, "no-existe", 2000)).toBeNull();
  expect(canjearInvitacion(c, k, 2000)).toEqual({ id: "U_SAM", name: "Sam" });
  expect(canjearInvitacion(c, k, 3000)).toBeNull();
  const vieja = nuevaInvitacion(c, { name: "Sam" }, 1000);
  expect(canjearInvitacion(c, vieja, 1000 + INVITACION_CADUCA_MS + 1)).toBeNull();
});

test("una clave que ya esta en la agenda no se sustituye, ni una clave se cuelga de dos ids", () => {
  const c = cfg();
  expect(vincularClave(c, { id: "U_SAM", name: "Sam", npub: K_SAM })).toBe("nueva");
  expect(vincularClave(c, { id: "U_SAM", name: "Sam", npub: K_SAM, relays: ["wss://nuevo"] })).toBe("igual");
  expect((Cfg.contactById(c, "U_SAM") as any).relays).toEqual(["wss://nuevo"]);
  expect(vincularClave(c, { id: "U_SAM", name: "Sam", npub: K_X })).toBe("conflicto");
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBe(K_SAM);
  expect(vincularClave(c, { id: "U_OTRO", name: "Otro", npub: K_SAM })).toBe("conflicto");
  expect(Cfg.contactById(c, "U_OTRO")).toBeNull();
});

test("un hola por Nostr solo entra con el nonce de mi invitacion, y se vincula a lo que yo apunte", () => {
  const c = cfg();
  Cfg.addContact(c, { id: "U_SAM", name: "Sam" });
  // El ataque del 07-09: un desconocido dice ser el Slack de Sam. Sin nonce, fuera.
  expect(holaPorNostr(c, { de: K_X, nombre: "Sam" })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBeUndefined();
  // Invito a Sam; su hola trae el nonce: queda vinculado al id que yo apunte, aunque el hola diga otro nombre.
  const k = nuevaInvitacion(c, { id: "U_SAM", name: "Sam" });
  const d = holaPorNostr(c, { de: K_SAM, nombre: "Samuel", k, relays: ["wss://sam"] });
  expect(d).toMatchObject({ ok: true, id: "U_SAM", name: "Sam", vinculo: "nueva" });
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBe(K_SAM);
  // El mismo nonce no vale dos veces, ni siquiera para otra clave.
  expect(holaPorNostr(c, { de: K_X, nombre: "Sam", k })).toMatchObject({ ok: false });
  // Una clave ya conocida puede volver a saludar sin nonce (cambio de reles), pero no cambiar de id.
  expect(holaPorNostr(c, { de: K_SAM, nombre: "Sam", relays: ["wss://otro"] })).toMatchObject({ ok: true, vinculo: "igual" });
  // Con un nonce valido, nadie sustituye la clave de Sam.
  const k2 = nuevaInvitacion(c, { id: "U_SAM", name: "Sam" });
  expect(holaPorNostr(c, { de: K_X, nombre: "Sam", k: k2 })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_SAM") as any).npub).toBe(K_SAM);
  // Una invitacion impresa (sin id) vincula a la clave, nunca a un id de Slack que diga el hola.
  const k3 = nuevaInvitacion(c, { name: "Sam" });
  expect(holaPorNostr(c, { de: K_BEA, nombre: "Sam", k: k3 })).toMatchObject({ ok: true, id: `nostr:${K_BEA}`, name: "Sam" });
});

test("un hola por Slack solo entra firmado con la clave ya fijada, o de un id que ya esta en la agenda", () => {
  const c = cfg();
  Cfg.addContact(c, { id: "U_BEA", name: "Bea", pk: "PK_BEA" });
  Cfg.addContact(c, { id: "U_SAM", name: "Sam" });
  // Sin firma o con firma falsa: no, aunque el id sea conocido. Asi era antes del 07-09.
  expect(holaPorSlack(c, { de: "U_BEA", nombre: "Bea", np: K_X, veredicto: "sin-firma" })).toMatchObject({ ok: false });
  expect(holaPorSlack(c, { de: "U_BEA", nombre: "Bea", np: K_X, veredicto: "mala" })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_BEA") as any).npub).toBeUndefined();
  // Un id que no esta en la agenda no se da de alta solo por firmar bien la primera vez.
  expect(holaPorSlack(c, { de: "U_NADIE", nombre: "Nadie", np: K_X, veredicto: "nueva" })).toMatchObject({ ok: false });
  expect(Cfg.contactById(c, "U_NADIE")).toBeNull();
  // Firmado con la clave fijada de Bea: entra.
  expect(holaPorSlack(c, { de: "U_BEA", nombre: "Bea", np: K_BEA, veredicto: "ok" })).toMatchObject({ ok: true, vinculo: "nueva" });
  // Sam esta en la agenda sin clave fijada: su primera firma vale (como con sus sobres).
  expect(holaPorSlack(c, { de: "U_SAM", nombre: "Sam", np: K_SAM, veredicto: "nueva" })).toMatchObject({ ok: true });
  // Y una vez con clave, nadie se la cambia por Slack aunque firme bien.
  expect(holaPorSlack(c, { de: "U_BEA", nombre: "Bea", np: K_X, veredicto: "ok" })).toMatchObject({ ok: false });
  expect((Cfg.contactById(c, "U_BEA") as any).npub).toBe(K_BEA);
});
