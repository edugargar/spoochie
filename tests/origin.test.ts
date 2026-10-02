import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inviteText } from "../src/join.ts";

test("la invitacion, el hook y el marketplace apuntan al mismo origen, y un fork solo cambia el marketplace", () => {
  const raiz = join(import.meta.dir, "..");
  const mk = JSON.parse(readFileSync(join(raiz, ".claude-plugin/marketplace.json"), "utf8"));
  expect(mk.origin).toBe(`${mk.name}/spoochie`);
  const inv = inviteText("eyJ" + "x".repeat(50), "Edu");
  expect(inv).toContain(`/plugin marketplace add ${mk.origin}`);
  expect(inv).toContain(`/plugin install spoochie@${mk.name}`);
  const hook = readFileSync(join(raiz, "hooks/session-start.sh"), "utf8");
  expect(hook).toContain('"origin"');
  expect(hook).toContain("marketplace.json");
});
