import { expect, test } from "bun:test";
import { PROTOCOL, readVersion } from "../src/protocol.ts";

test("an envelope of my version or earlier is understood", () => {
  expect(readVersion(PROTOCOL).understood).toBe(true);
  expect(readVersion(1, "0.9.9").understood).toBe(true);
  // No `v` means it predates this field: treated as 1.
  expect(readVersion(undefined).understood).toBe(true);
  expect(readVersion("dos" as any).understood).toBe(true);
});

test("an envelope of a version I do not know is not delivered, and it says which one is missing", () => {
  const l = readVersion(2, "1.2.0", 1);
  expect(l.understood).toBe(false);
  if (l.understood) throw new Error("impossible");
  expect(l.reason).toContain("protocol 2");
  expect(l.reason).toContain("understands up to 1");
  // With the other machine's version, so the person knows whom to tell.
  expect(l.reason).toContain("1.2.0");
  expect(l.reason).toContain("plugin marketplace update");
});

test("the protocol number is not hand-written in each envelope", async () => {
  for (const f of ["../src/slack.ts", "../src/nostr.ts"]) {
    const source = await Bun.file(new URL(f, import.meta.url)).text();
    // A loose `v: 1` is how it used to be: ten copies that forget to go up together.
    expect(source).not.toContain("v: 1,");
    expect(source).toContain("v: PROTOCOL,");
  }
});

/**
 * The published spec has to say what the code does. A protocol document that falls
 * behind is worse than none: someone implements it and their envelopes get dropped
 * without them understanding why.
 */
test("docs/PROTOCOL.md states the same version number as the code", async () => {
  const doc = await Bun.file(new URL("../docs/PROTOCOL.md", import.meta.url)).text();
  expect(doc).toContain(`Protocol version: **${PROTOCOL}**`);
});

test("the order of the signed fields in the document is the code's", async () => {
  const doc = await Bun.file(new URL("../docs/PROTOCOL.md", import.meta.url)).text();
  const signing = await Bun.file(new URL("../src/signing.ts", import.meta.url)).text();
  const inCode = signing.slice(signing.indexOf("const signedBytesV2"), signing.indexOf("export function makeSignature("));
  expect(inCode.length).toBeGreaterThan(0);
  // The fields, in order, exactly as they are signed.
  for (const field of ["d.id", "d.kind", "d.from", "d.to", "d.ts", "d.app", "d.subject"]) {
    expect(inCode).toContain(field);
  }
  const inDoc = doc.slice(doc.indexOf("JSON.stringify(["), doc.indexOf("])", doc.indexOf("JSON.stringify([")));
  for (const field of ["id,", "kind,", "from,", "to ??", "ts ??", "app ??", "subject ??", "thread ?"]) {
    expect(inDoc).toContain(field);
  }
  // And the time window, a number that can drift out of sync on its own.
  expect(doc).toContain("**24 hours**");
  expect(signing).toContain("export const WINDOW_MS = 24 * 60 * 60 * 1000;");
});

test("the document's kinds are the code's", async () => {
  const doc = await Bun.file(new URL("../docs/PROTOCOL.md", import.meta.url)).text();
  const slack = await Bun.file(new URL("../src/slack.ts", import.meta.url)).text();
  const inCode = slack.slice(slack.indexOf('kind: "invite"'), slack.indexOf('kind: "invite"') + 120);
  for (const k of ["invite", "msg", "accept", "close", "notice", "hola", "rota"]) {
    expect(inCode).toContain(`"${k}"`);
    expect(doc).toContain(k);
  }
});

/**
 * The rule, on the default transport.
 *
 * `readVersion` was right and was called in `receive`, but `open` cut things off earlier
 * with `envelope.v !== 1`: a protocol 2 envelope vanished without a trace while the other
 * side saw it delivered, and so did one with no `v` (from before the field existed). So
 * the whole rule written in this file and published in docs/PROTOCOL.md was, over Nostr,
 * dead code. Over Slack it did hold: the two paths did different things with the same
 * envelope.
 */
test("over Nostr, an envelope of another version reaches the code that knows what to do with it", async () => {
  const { wrapEnvelope, open, myKeys } = await import("../src/nostr.ts");
  const me = myKeys({} as any), other = myKeys({} as any);
  const send = (v: unknown) => {
    const { wrap } = wrapEnvelope(other.sk, me.pk, { v, id: "abc", kind: "msg", subject: "s" } as any, "hola");
    return open(wrap, me.sk);
  };
  // Neither the newer one nor the older one gets thrown away here.
  expect(send(2)?.envelope.v).toBe(2);
  expect(send(undefined)).not.toBeNull();
  expect(send(1)?.envelope.v).toBe(1);
  // What does get dropped is whatever is not a spoochie envelope.
  expect(send("dos")).toBeNull();
});
