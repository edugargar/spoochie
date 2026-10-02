import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Up to 0.9.10 the CLI had Spanish subcommands and flags. Asides started by an older
 * daemon have `portero` and `centinela` written in their hooks, and people have the old
 * flags in their notes, so each old spelling must do exactly what the new one does.
 */
function home() {
  const h = mkdtempSync(join(tmpdir(), "sp-alias-"));
  mkdirSync(join(h, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(join(h, "config.json"), JSON.stringify({ human: "Ana", guardian: false, transcript: false, slack: { userId: "U_ANA" } }), { mode: 0o600 });
  return h;
}
function cli(h: string, args: string[], input = "") {
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, SPOOCHIE_HOME: h, SPOOCHIE_NOTICE: "terminal", SPOOCHIE_OFFLINE: "1" }, encoding: "utf8", input,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.replaceAll(h, "<home>") };
}

const PAIRS: [string[], string[], string?][] = [
  [["auditoria"], ["audit"]],
  [["confiar"], ["trust"]],
  [["olvidar"], ["forget"]],
  [["portero"], ["gatekeeper"], JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } })],
  [["centinela"], ["sentinel"], "{}"],
];

for (const [old, now, input] of PAIRS) {
  test(`\`${old.join(" ")}\` does what \`${now.join(" ")}\` does`, () => {
    const a = cli(home(), old, input), b = cli(home(), now, input);
    expect(a.code).toBe(b.code);
    expect(a.out).toBe(b.out);
    expect(b.out).not.toContain("unknown");
  });
}

test("the old config flags store the same config as the new ones", () => {
  const a = home(), b = home();
  expect(cli(a, ["config", "--aparte", "off", "--copia", "off", "--borrar", "off", "--transporte", "slack", "--hilos", "canal", "--canal", "C0TEST"]).code).toBe(0);
  expect(cli(b, ["config", "--aside", "off", "--copy", "off", "--erase", "off", "--transport", "slack", "--threads", "channel", "--channel", "C0TEST"]).code).toBe(0);
  const read = (h: string) => JSON.parse(readFileSync(join(h, "config.json"), "utf8"));
  expect(read(a)).toEqual(read(b));
  // And the values on disk are still the ones 0.9.10 reads.
  expect(read(b).aparte).toBe(false);
  expect(read(b).slack?.hilos).toBe("canal");
});
