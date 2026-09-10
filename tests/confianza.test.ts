import { expect, test } from "bun:test";
import { nivelDe, entraSolo, confiar, ponerNivel, nombreRepo } from "../src/confianza.ts";
import type * as Cfg from "../src/config.ts";

const agenda = (): Cfg.Config => ({
  guardian: true, transcript: false,
  contacts: {
    sam: { id: "U_SAM", name: "Sam", npub: "a".repeat(64) },
    ana: { id: "U_ANA", name: "Ana" },
  },
});

test("por defecto todo el mundo es confianza normal y nada entra solo", () => {
  const c = agenda();
  expect(nivelDe(c, { slackUser: "U_SAM" })).toBe("normal");
  expect(entraSolo(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(false);
  // Alguien que no esta en la agenda no gana nada por preguntar.
  expect(nivelDe(c, { slackUser: "U_NADIE" })).toBe("normal");
  expect(entraSolo(c, { slackUser: "U_NADIE" }, "/x/anthias")).toBe(false);
});

test("el consentimiento es por persona Y por repo, nunca global", () => {
  const c = agenda();
  expect(confiar(c, "Sam", "anthias").ok).toBe(true);
  expect(entraSolo(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(true);
  // Otro repo del mismo Sam: no.
  expect(entraSolo(c, { slackUser: "U_SAM" }, "/Users/x/repos/website")).toBe(false);
  // El mismo repo de otra persona: tampoco.
  expect(entraSolo(c, { slackUser: "U_ANA" }, "/Users/x/repos/anthias")).toBe(false);
  // Y se puede quitar.
  expect(confiar(c, "Sam", "anthias", true).ok).toBe(true);
  expect(entraSolo(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(false);
});

test("el contacto se encuentra tambien por su clave Nostr, que es como llega sin Slack", () => {
  const c = agenda();
  confiar(c, "Sam", "anthias");
  expect(entraSolo(c, { npub: "a".repeat(64) }, "/x/anthias")).toBe(true);
  expect(entraSolo(c, { npub: "b".repeat(64) }, "/x/anthias")).toBe(false);
});

test("confiar en quien no esta en la agenda no lo mete en la agenda", () => {
  const c = agenda();
  const r = confiar(c, "Intruso", "anthias");
  expect(r.ok).toBe(false);
  expect(Object.keys(c.contacts ?? {})).toEqual(["sam", "ana"]);
});

test("el nivel alto se pone y se quita, y no toca nada mas del contacto", () => {
  const c = agenda();
  expect(ponerNivel(c, "Sam", "alto").ok).toBe(true);
  expect(nivelDe(c, { slackUser: "U_SAM" })).toBe("alto");
  expect(c.contacts!.sam.npub).toBe("a".repeat(64));
  expect(ponerNivel(c, "Sam", "normal").ok).toBe(true);
  expect(nivelDe(c, { slackUser: "U_SAM" })).toBe("normal");
  expect(c.contacts!.sam.nivel).toBeUndefined();
});

test("el nombre del repo es el ultimo trozo de la ruta, con o sin barra final", () => {
  expect(nombreRepo("/Users/x/repos/anthias")).toBe("anthias");
  expect(nombreRepo("/Users/x/repos/anthias/")).toBe("anthias");
});

test("de un contacto se guarda cuando se le oyo, no si esta ahi ahora", async () => {
  const Cfg = await import("../src/config.ts");
  const { hace } = await import("../src/confianza.ts");
  Cfg.save({ guardian: false, transcript: false, contacts: { sam: { id: "U_SAM", name: "Sam", npub: "c".repeat(64) } } });
  Cfg.tocarContacto({ id: "U_SAM" }, 1_000_000);
  expect((Cfg.contactById(Cfg.load(), "U_SAM") as any).visto).toBe(1_000_000);
  // Tambien por clave Nostr, que es como llega sin Slack.
  Cfg.tocarContacto({ npub: "c".repeat(64) }, 2_000_000);
  expect((Cfg.contactById(Cfg.load(), "U_SAM") as any).visto).toBe(2_000_000);
  // Y un desconocido no entra en la agenda por escribir.
  Cfg.tocarContacto({ id: "U_NADIE" }, 3_000_000);
  expect(Cfg.contactById(Cfg.load(), "U_NADIE")).toBeNull();

  const t0 = 1_700_000_000_000;
  expect(hace(t0, t0 + 30_000)).toBe("ahora mismo");
  expect(hace(t0, t0 + 4 * 60_000)).toBe("hace 4 min");
  expect(hace(t0, t0 + 3 * 3600_000)).toBe("hace 3 h");
  expect(hace(t0, t0 + 5 * 24 * 3600_000)).toBe("hace 5 dias");
});
