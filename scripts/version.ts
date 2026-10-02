#!/usr/bin/env bun
/**
 * The version lives in .claude-plugin/plugin.json and gets copied from there to
 * package.json and the marketplace, plus a new entry in CHANGELOG.md. It used to be
 * three `sed` by hand, and one day they drifted apart.
 *
 *   bun scripts/version.ts 0.8.0 "What changes, in one line"
 */
import { readFileSync, writeFileSync } from "node:fs";
const [v, ...rest] = process.argv.slice(2);
if (!v || !/^\d+\.\d+\.\d+$/.test(v)) { console.error("usage: bun scripts/version.ts X.Y.Z [summary]"); process.exit(1); }
const put = (f: string, re: RegExp, rep: string) => writeFileSync(f, readFileSync(f, "utf8").replace(re, rep));
put(".claude-plugin/plugin.json", /"version": "[^"]+"/, `"version": "${v}"`);
put("package.json", /"version": "[^"]+"/, `"version": "${v}"`);
put(".claude-plugin/marketplace.json", /"version": "[^"]+"/, `"version": "${v}"`);
const today = new Date().toISOString().slice(0, 10);
const log = readFileSync("CHANGELOG.md", "utf8");
if (!log.includes(`## ${v} `)) {
  const entry = `## ${v} (${today})\n\n${rest.length ? `- ${rest.join(" ")}\n` : "- \n"}\n`;
  writeFileSync("CHANGELOG.md", log.replace(/^(# Changelog\n\n)/, `$1${entry}`));
}
console.log(`version ${v} in plugin.json, package.json, marketplace.json and CHANGELOG.md`);
