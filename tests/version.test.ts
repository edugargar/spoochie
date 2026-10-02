import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the version is the same in plugin.json, package.json, marketplace.json and heads the CHANGELOG", () => {
  const root = join(import.meta.dir, "..");
  const v = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
  const plugin = v(".claude-plugin/plugin.json").version;
  expect(v("package.json").version).toBe(plugin);
  expect(v(".claude-plugin/marketplace.json").plugins[0].version).toBe(plugin);
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  expect(log.split("\n").find(l => l.startsWith("## "))).toStartWith(`## ${plugin} `);
});
