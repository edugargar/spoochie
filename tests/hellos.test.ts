import { expect, test } from "bun:test";
import { helloDue, forgetHello, HELLO_EVERY_MS } from "../src/hellos.ts";

test("the key goes over Slack at most once a day per contact, and it is remembered across restarts", () => {
  const t0 = 1_700_000_000_000;
  expect(helloDue("U_UNO", t0)).toBe(true);
  // Same start or another one: no repeat until a day has passed.
  expect(helloDue("U_UNO", t0 + 35_000)).toBe(false);
  expect(helloDue("U_UNO", t0 + HELLO_EVERY_MS - 1)).toBe(false);
  expect(helloDue("U_UNO", t0 + HELLO_EVERY_MS)).toBe(true);
  // Another contact goes on its own.
  expect(helloDue("U_DOS", t0)).toBe(true);
  // If it is forgotten (they had a key and lost it), it is due again.
  forgetHello("U_UNO");
  expect(helloDue("U_UNO", t0 + HELLO_EVERY_MS + 1)).toBe(true);
});
