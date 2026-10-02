import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inviteText } from "../src/join.ts";

test("the invite, the hook and the marketplace point at the same origin, and a fork only changes the marketplace", () => {
  const root = join(import.meta.dir, "..");
  const mk = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  expect(mk.origin).toBe(`${mk.name}/spoochie`);
  const inv = inviteText("eyJ" + "x".repeat(50), "Edu");
  expect(inv).toContain(`/plugin marketplace add ${mk.origin}`);
  expect(inv).toContain(`/plugin install spoochie@${mk.name}`);
  const hook = readFileSync(join(root, "hooks/session-start.sh"), "utf8");
  expect(hook).toContain('"origin"');
  expect(hook).toContain("marketplace.json");
});
