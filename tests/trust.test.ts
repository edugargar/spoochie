import { expect, test } from "bun:test";
import { levelOf, autoAccepts, trust, setLevel, repoName } from "../src/trust.ts";
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
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("normal");
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(false);
  // Alguien que no esta en la agenda no gana nada por preguntar.
  expect(levelOf(c, { slackUser: "U_NADIE" })).toBe("normal");
  expect(autoAccepts(c, { slackUser: "U_NADIE" }, "/x/anthias")).toBe(false);
});

test("el consentimiento es por persona Y por repo, nunca global", () => {
  const c = agenda();
  expect(trust(c, "Sam", "anthias").ok).toBe(true);
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(true);
  // Otro repo del mismo Sam: no.
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/website")).toBe(false);
  // El mismo repo de otra persona: tampoco.
  expect(autoAccepts(c, { slackUser: "U_ANA" }, "/Users/x/repos/anthias")).toBe(false);
  // Y se puede quitar.
  expect(trust(c, "Sam", "anthias", true).ok).toBe(true);
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(false);
});

test("el contacto se encuentra tambien por su clave Nostr, que es como llega sin Slack", () => {
  const c = agenda();
  trust(c, "Sam", "anthias");
  expect(autoAccepts(c, { npub: "a".repeat(64) }, "/x/anthias")).toBe(true);
  expect(autoAccepts(c, { npub: "b".repeat(64) }, "/x/anthias")).toBe(false);
});

test("confiar en quien no esta en la agenda no lo mete en la agenda", () => {
  const c = agenda();
  const r = trust(c, "Intruso", "anthias");
  expect(r.ok).toBe(false);
  expect(Object.keys(c.contacts ?? {})).toEqual(["sam", "ana"]);
});

test("el nivel alto se pone y se quita, y no toca nada mas del contacto", () => {
  const c = agenda();
  expect(setLevel(c, "Sam", "alto").ok).toBe(true);
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("alto");
  expect(c.contacts!.sam.npub).toBe("a".repeat(64));
  expect(setLevel(c, "Sam", "normal").ok).toBe(true);
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("normal");
  expect(c.contacts!.sam.nivel).toBeUndefined();
});

test("el nombre del repo es el ultimo trozo de la ruta, con o sin barra final", () => {
  expect(repoName("/Users/x/repos/anthias")).toBe("anthias");
  expect(repoName("/Users/x/repos/anthias/")).toBe("anthias");
});

test("de un contacto se guarda cuando se le oyo, no si esta ahi ahora", async () => {
  const Cfg = await import("../src/config.ts");
  const { ago } = await import("../src/trust.ts");
  Cfg.save({ guardian: false, transcript: false, contacts: { sam: { id: "U_SAM", name: "Sam", npub: "c".repeat(64) } } });
  Cfg.touchContact({ id: "U_SAM" }, 1_000_000);
  expect((Cfg.contactById(Cfg.load(), "U_SAM") as any).visto).toBe(1_000_000);
  // Tambien por clave Nostr, que es como llega sin Slack.
  Cfg.touchContact({ npub: "c".repeat(64) }, 2_000_000);
  expect((Cfg.contactById(Cfg.load(), "U_SAM") as any).visto).toBe(2_000_000);
  // Y un desconocido no entra en la agenda por escribir.
  Cfg.touchContact({ id: "U_NADIE" }, 3_000_000);
  expect(Cfg.contactById(Cfg.load(), "U_NADIE")).toBeNull();

  const t0 = 1_700_000_000_000;
  expect(ago(t0, t0 + 30_000)).toBe("ahora mismo");
  expect(ago(t0, t0 + 4 * 60_000)).toBe("hace 4 min");
  expect(ago(t0, t0 + 3 * 3600_000)).toBe("hace 3 h");
  expect(ago(t0, t0 + 5 * 24 * 3600_000)).toBe("hace 5 dias");
});

test("olvidar cierra lo suyo y deja de conocerle, y sin servidor no hay mas que eso", async () => {
  const fuente = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
  const f = fuente.slice(fuente.indexOf('case "olvidar"'), fuente.indexOf('// Cerrar de una vez los N tuneles'));
  // Cierra los spoochies vivos con esa persona, por los dos transportes.
  expect(f).toContain("t.from.slackUser === x.id || t.to.slackUser === x.id || t.nostr?.otro === x.npub");
  expect(f).toContain("await closeThread(t");
  // Y la borra entera, clave incluida: no es lo mismo que --olvidar-clave.
  expect(f).toContain("delete c.contacts![clave]");
  // Queda apuntado en el registro, que es donde se mira despues.
  expect(f).toContain('Aud.record("confianza"');
});
