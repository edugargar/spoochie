import { expect, test } from "bun:test";
import { newKeys, verifyEnvelope } from "../src/signing.ts";
import { signedRotation } from "../src/slack.ts";
import { incomingRotation } from "../src/keys.ts";
import * as Cfg from "../src/config.ts";

const withContacts = (pk?: string) => {
  Cfg.save({ guardian: false, transcript: false, slack: { userId: "U_YO", pollMs: 20_000 }, contacts: { sam: { id: "U_SAM", name: "Sam", ...(pk ? { pk } : {}) } } });
  return Cfg.load();
};

test("a rotation signed with the old key changes the pinned key", () => {
  const old = newKeys(), fresh = newKeys();
  const c = withContacts(old.pub);
  const env = signedRotation("U_SAM", "U_YO", "Sam", fresh.pub, old.priv, old.pub);
  // The signed text is the new key: without that, the signature does not bind what is announced.
  const verdict = verifyEnvelope(env as any, fresh.pub);
  expect(verdict).toBe("ok");
  const r = incomingRotation(c, "U_SAM", fresh.pub, verdict);
  expect(r.ok).toBe(true);
  expect(Cfg.contactById(c, "U_SAM")?.pk).toBe(fresh.pub);
});

test("signed with another key, it does not", () => {
  const old = newKeys(), fresh = newKeys(), impostor = newKeys();
  const c = withContacts(old.pub);
  const env = signedRotation("U_SAM", "U_YO", "Sam", fresh.pub, impostor.priv, impostor.pub);
  const verdict = verifyEnvelope(env as any, fresh.pub);
  expect(verdict).toBe("mala");
  expect(incomingRotation(c, "U_SAM", fresh.pub, verdict).ok).toBe(false);
  expect(Cfg.contactById(c, "U_SAM")?.pk).toBe(old.pub);
});

test("a rotation from someone with no pinned key is not accepted", () => {
  // It would be someone we knew nothing about debuting with a key change. It is stopped
  // twice: by the verdict ("nueva" is not "ok") and, just in case, by checking there was
  // a key to replace.
  const c = withContacts();
  const byVerdict = incomingRotation(c, "U_SAM", newKeys().pub, "nueva");
  expect(byVerdict.ok).toBe(false);
  if (byVerdict.ok) throw new Error("impossible");
  expect(byVerdict.reason).toContain("does not match the pinned key");

  const byMissingKey = incomingRotation(c, "U_SAM", newKeys().pub, "ok");
  expect(byMissingKey.ok).toBe(false);
  if (byMissingKey.ok) throw new Error("impossible");
  expect(byMissingKey.reason).toContain("there was no key pinned");
});

test("a rotation to the same key, or to something that is not a key, is rejected", () => {
  const old = newKeys();
  const c = withContacts(old.pub);
  expect(incomingRotation(c, "U_SAM", old.pub, "ok").ok).toBe(false);
  expect(incomingRotation(c, "U_SAM", "no", "ok").ok).toBe(false);
});

test("the rotation notice is read in the DM, not only in the envelope", async () => {
  const slack = await Bun.file(new URL("../src/slack.ts", import.meta.url)).text();
  const f = slack.slice(slack.indexOf("async rotate("), slack.indexOf("onRotation:"));
  // If your old key was stolen, the thief can sign the rotation too. All that is left is
  // for the person to see it written and ask through some other channel.
  expect(f).toContain("ask them through some other channel");
});
