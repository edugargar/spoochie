import { expect, test } from "bun:test";
import { levelOf, autoAccepts, trust, setLevel, repoName } from "../src/trust.ts";
import type * as Cfg from "../src/config.ts";

const contacts = (): Cfg.Config => ({
  guardian: true, transcript: false,
  contacts: {
    sam: { id: "U_SAM", name: "Sam", npub: "a".repeat(64) },
    ana: { id: "U_ANA", name: "Ana" },
  },
});

test("by default everyone gets normal trust and nothing gets in on its own", () => {
  const c = contacts();
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("normal");
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(false);
  // Someone not in the contacts gains nothing by asking.
  expect(levelOf(c, { slackUser: "U_NADIE" })).toBe("normal");
  expect(autoAccepts(c, { slackUser: "U_NADIE" }, "/x/anthias")).toBe(false);
});

test("consent is per person AND per repo, never global", () => {
  const c = contacts();
  expect(trust(c, "Sam", "anthias").ok).toBe(true);
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(true);
  // Another repo from the same Sam: no.
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/website")).toBe(false);
  // The same repo from another person: no either.
  expect(autoAccepts(c, { slackUser: "U_ANA" }, "/Users/x/repos/anthias")).toBe(false);
  // And it can be removed.
  expect(trust(c, "Sam", "anthias", true).ok).toBe(true);
  expect(autoAccepts(c, { slackUser: "U_SAM" }, "/Users/x/repos/anthias")).toBe(false);
});

test("the contact is also found by their Nostr key, which is how they arrive without Slack", () => {
  const c = contacts();
  trust(c, "Sam", "anthias");
  expect(autoAccepts(c, { npub: "a".repeat(64) }, "/x/anthias")).toBe(true);
  expect(autoAccepts(c, { npub: "b".repeat(64) }, "/x/anthias")).toBe(false);
});

test("trusting someone not in the contacts does not add them to the contacts", () => {
  const c = contacts();
  const r = trust(c, "Intruso", "anthias");
  expect(r.ok).toBe(false);
  expect(Object.keys(c.contacts ?? {})).toEqual(["sam", "ana"]);
});

test("the high level is set and removed, and touches nothing else on the contact", () => {
  const c = contacts();
  expect(setLevel(c, "Sam", "alto").ok).toBe(true);
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("alto");
  expect(c.contacts!.sam.npub).toBe("a".repeat(64));
  expect(setLevel(c, "Sam", "normal").ok).toBe(true);
  expect(levelOf(c, { slackUser: "U_SAM" })).toBe("normal");
  expect(c.contacts!.sam.nivel).toBeUndefined();
});

test("the repo name is the last chunk of the path, with or without a trailing slash", () => {
  expect(repoName("/Users/x/repos/anthias")).toBe("anthias");
  expect(repoName("/Users/x/repos/anthias/")).toBe("anthias");
});

test("what is stored about a contact is when they were heard from, not whether they are there now", async () => {
  const Cfg = await import("../src/config.ts");
  const { ago } = await import("../src/trust.ts");
  Cfg.save({ guardian: false, transcript: false, contacts: { sam: { id: "U_SAM", name: "Sam", npub: "c".repeat(64) } } });
  Cfg.touchContact({ id: "U_SAM" }, 1_000_000);
  expect((Cfg.contactById(Cfg.load(), "U_SAM") as any).visto).toBe(1_000_000);
  // Also by Nostr key, which is how they arrive without Slack.
  Cfg.touchContact({ npub: "c".repeat(64) }, 2_000_000);
  expect((Cfg.contactById(Cfg.load(), "U_SAM") as any).visto).toBe(2_000_000);
  // And a stranger does not get into the contacts by writing.
  Cfg.touchContact({ id: "U_NADIE" }, 3_000_000);
  expect(Cfg.contactById(Cfg.load(), "U_NADIE")).toBeNull();

  const t0 = 1_700_000_000_000;
  expect(ago(t0, t0 + 30_000)).toBe("just now");
  expect(ago(t0, t0 + 4 * 60_000)).toBe("4 min ago");
  expect(ago(t0, t0 + 3 * 3600_000)).toBe("3 h ago");
  expect(ago(t0, t0 + 5 * 24 * 3600_000)).toBe("5 days ago");
});

test("forget closes their spoochies and stops knowing them, and with no server that is all there is", async () => {
  const source = await Bun.file(new URL("../src/daemon.ts", import.meta.url)).text();
  // "olvidar" is the RPC op name, which stays as is.
  const f = source.slice(source.indexOf('case "olvidar"'), source.indexOf('case "close-grupo"'));
  expect(f.length).toBeGreaterThan(0);
  // Closes the live spoochies with that person, over both transports.
  expect(f).toContain("t.from.slackUser === x.id || t.to.slackUser === x.id || t.nostr?.otro === x.npub");
  expect(f).toContain("await closeThread(t");
  // And deletes them entirely, key included: not the same as --forget-key.
  expect(f).toContain("delete c.contacts![key]");
  // It is recorded in the log, which is where people look afterwards.
  expect(f).toContain('Aud.record("confianza"');
});
