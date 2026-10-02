import { test, expect } from "bun:test";
import { newKeys } from "../src/signing.ts";
import { cleanString, readInvite, createInvite, inviteData } from "../src/join.ts";

// An invite is worth the inviter's public keys, not any secret.
const ME = { id: "U0EDU001", name: "Edu", np: "a".repeat(64) };
const blob = Buffer.from(JSON.stringify({ t: "Equipo", i: ME })).toString("base64url");

test("the string is pulled out of the whole pasted command", () => {
  expect(cleanString(`spoochie join ${blob} --email ana@example.com`)).toBe(blob);
});

test("the string is pulled out of the plugin slash command and Slack backticks", () => {
  expect(cleanString("/spoochie:join `" + blob + "`")).toBe(blob);
});

test("the bare string works as is", () => {
  expect(cleanString(blob)).toBe(blob);
});

test("with no string, none is made up", () => {
  expect(cleanString("spoochie join --email ana@example.com")).toBeNull();
  expect(cleanString("")).toBeNull();
});

test("a long flag is not mistaken for the string", () => {
  expect(cleanString(`--${"x".repeat(60)} ${blob}`)).toBe(blob);
});

test("the invite carries the inviter's key, and no secret", () => {
  expect(readInvite(blob)?.i?.np).toBe("a".repeat(64));
  expect(readInvite(blob)?.t).toBe("Equipo");
  expect(Buffer.from(blob, "base64url").toString()).not.toContain("xoxb-");
});

test("what is not an invite does not get through", () => {
  expect(readInvite("not-base64-of-anything")).toBeNull();
  expect(readInvite(Buffer.from(JSON.stringify({ t: "Equipo" })).toString("base64url"))).toBeNull();
  // A bare token no longer makes a string valid: with no Nostr key it is not an invite.
  expect(readInvite(Buffer.from(JSON.stringify({ b: "xoxb-" + "z".repeat(40) })).toString("base64url"))).toBeNull();
});

import { createInvite, inviteText } from "../src/join.ts";
import * as Cfg from "../src/config.ts";

test("an addressed invite carries who it is for and who invites, and survives pasting", () => {
  const blob = createInvite({ t: "Equipo", u: "U0SAM001", n: "Sam", i: ME });
  const read = readInvite(cleanString(inviteText(blob, "Edu"))!);
  expect(read?.u).toBe("U0SAM001");
  expect(read?.n).toBe("Sam");
  expect(read?.i).toEqual({ id: "U0EDU001", name: "Edu", np: "a".repeat(64) });
});

test("a recipient that does not look like a Slack id is ignored", () => {
  const blob = createInvite({ i: ME, u: "../etc" as any });
  expect(readInvite(blob)?.u).toBeUndefined();
});

test("the DM carries the four steps and the whole string", () => {
  const blob = createInvite({ i: ME });
  const t = inviteText(blob, "Edu");
  expect(t).toContain("/plugin marketplace add edugargar/spoochie");
  expect(t).toContain("/plugin install spoochie@edugargar");
  expect(t).toContain(`/spoochie:join ${blob}`);
});

test("the contacts resolve @name ignoring case and spaces", () => {
  const c: Cfg.Config = { guardian: true, transcript: false };
  Cfg.addContact(c, { id: "U0EDU001", name: "Edu Garcia" });
  expect(Cfg.contact(c, "edugarcia")?.id).toBe("U0EDU001");
  expect(Cfg.contact(c, "EduGarcia")?.id).toBe("U0EDU001");
  expect(Cfg.contact(c, "sam")).toBeNull();
});

test("there is no way to put the bot token in an invite", async () => {
  const { inviteData, createInvite, readInvite, inviteText } = await import("../src/join.ts");
  const yo = { id: "U0EDU001", name: "Edu", np: "a".repeat(64), r: ["wss://x"] };
  const inv = inviteData({ team: "Equipo", dest: { id: "U0SAM001", name: "Sam" }, yo });
  expect(inv.u).toBe("U0SAM001");
  expect(inv.i?.np).toBe("a".repeat(64));
  // Anyone can open the string with a base64 decoder: there is no token inside, and no
  // flag is left that puts it back. There used to be one: --con-slack.
  const blob = createInvite(inv);
  const inside = Buffer.from(blob, "base64url").toString();
  expect(inside).not.toContain("xoxb-");
  expect(inside).not.toContain("xoxp-");
  expect(JSON.parse(inside).b).toBeUndefined();
  expect(readInvite(blob)?.u).toBe("U0SAM001");
  expect(inviteText(blob, "Edu")).toContain("There is no password inside");
  expect(inviteText(blob, "Edu")).not.toContain("token");
});

test("an old invite with a token inside is read, but the token is dropped and reported", async () => {
  const { createInvite, readInvite } = await import("../src/join.ts");
  // What `spoochie invite --con-slack` sent up to 0.9.8.
  const old = createInvite({ t: "Equipo", u: "U0SAM001", i: ME, ...({ b: "xoxb-" + "z".repeat(40) } as any) });
  const read = readInvite(old);
  expect(read?.u).toBe("U0SAM001");
  expect(read?.traiaToken).toBe(true);
  expect(JSON.stringify(read)).not.toContain("xoxb-");
});

/**
 * The seam between the two halves of the join.
 *
 * The single-use nonce had its tests (`keys.test.ts`) and the string had its own, but
 * nobody tested the whole trip: `readInvite` did not copy `k`, so `join` sent the hello
 * with the nonce undefined and on the other side `redeemInvite` returned null. A
 * newcomer's hello always landed in "no valid invite and unknown key" and joining over
 * Nostr did not work: you had to add them by hand with `--npub`, which is the fallback
 * path, not the normal one.
 */
test("the nonce survives the whole trip: recorded on invite, carried in the string, and redeemed", async () => {
  const { newInvite, redeemInvite } = await import("../src/keys.ts");
  const c: any = {};
  const k = newInvite(c, { id: "U_SAM", name: "Sam" }, 1000);

  const blob = createInvite(inviteData({
    team: "Equipo", dest: { id: "U_SAM", name: "Sam" },
    yo: { id: "U_EDU", name: "Edu", np: "a".repeat(64), r: ["wss://uno"] }, k,
  }));
  const read = readInvite(blob);
  expect(read?.k).toBe(k);
  // And with that nonce, the inviter recognises who is joining.
  expect(redeemInvite(c, read!.k, 2000)).toEqual({ id: "U_SAM", name: "Sam" });
});

test("what comes in the string has a shape and a size, or it does not get in", () => {
  const base = (i: any) => readInvite(createInvite({ i: { np: "b".repeat(64), ...i } } as any));
  // The name ends up in the contacts and in the notice headline: the inviter does not choose how much room it takes.
  expect(base({ id: "U1", name: "N".repeat(5000) })?.i?.name.length).toBe(60);
  // The ed25519 key is an SPKI in base64. Any string used to get pinned anyway, and from
  // then on every signed envelope from that person came out "mala" without anyone knowing why.
  expect(base({ id: "U1", name: "x", pk: "not a key" })?.i?.pk).toBeUndefined();
  expect(base({ id: "U1", name: "x", pk: newKeys().pub })?.i?.pk).toBeString();
  // And a nonce that does not look like a nonce does not travel either.
  expect(readInvite(createInvite({ k: "short", i: { id: "U1", name: "x", np: "b".repeat(64) } } as any))?.k).toBeUndefined();
});
