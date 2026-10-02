import { expect, test } from "bun:test";
import { read } from "../src/audit.ts";
import { readFileSync } from "node:fs";

test("each line of the log is when, what, which, who and a short detail", () => {
  const raw = [
    "2026-09-10T10:00:00.000Z\tabierto\tk7f\tEdu\t-> Sam · the modal",
    "2026-09-10T10:01:00.000Z\tretenido\tk7f\tSam\tasks to run a script",
    "2026-09-10T10:02:00.000Z\tsoltado\tk7f\tEdu\t1 message(s) · from Slack",
  ].join("\n") + "\n";
  const l = read(50, raw);
  expect(l).toHaveLength(3);
  expect(l[0]).toEqual({ cuando: "2026-09-10T10:00:00.000Z", hecho: "abierto", id: "k7f", quien: "Edu", detalle: "-> Sam · the modal" });
  expect(l[1].hecho).toBe("retenido");
  expect(l[2].quien).toBe("Edu");
  // The tail is read, which is what matters when the file is months old.
  expect(read(1, raw)[0].hecho).toBe("soltado");
  expect(read(50, "")).toEqual([]);
});

test("the log does not keep the text of the messages: erase-on-close stays true", () => {
  const source = readFileSync(new URL("../src/audit.ts", import.meta.url), "utf8");
  // What gets written is fact, id, who and detail. Nothing receives m.text.
  expect(source).toContain("never the text of the messages");
  const daemon = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  for (const line of daemon.split("\n").filter(l => l.includes("Aud.record("))) {
    expect(line).not.toContain("m.text");
    expect(line).not.toContain(".messages[");
  }
  // And there is at least one entry for each decision a person makes. The values are
  // the on-disk log tags, which stay Spanish.
  for (const fact of ["abierto", "aceptado", "rechazado", "retenido", "cerrado"]) {
    expect(daemon).toContain(`Aud.record("${fact}"`);
  }
  // Release and discard come from the same place, depending on what the person typed.
  expect(daemon).toMatch(/Aud\.record\(\w+ === "suelta" \? "soltado" : "descartado"/);
});

/**
 * A state directory that already existed open stayed open.
 *
 * `mkdirSync`'s `mode` only applies on creation. Inside that directory are the config
 * with the three keys, the daemon socket (through which any local process opens a tunnel
 * without asking), the threads and the spool. `spoochie doctor` said so, but doctor runs
 * once something is already broken, not every day.
 */
test("a state directory with open permissions gets closed on start", async () => {
  const { mkdtempSync, mkdirSync, chmodSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "sp-perms-"));
  const home = join(base, "state");
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o755);
  expect(statSync(home).mode & 0o077).not.toBe(0);

  const before = process.env.SPOOCHIE_HOME;
  try {
    // `ROOT` is computed when paths.ts is imported, so the isolation goes through a
    // separate process: the same thing that really happens, a fresh start on an old directory.
    const r = Bun.spawnSync(["bun", "-e", 'const {ensureDirs}=await import("./src/paths.ts"); ensureDirs();'], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, SPOOCHIE_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(statSync(home).mode & 0o077).toBe(0);
    expect(statSync(join(home, "sessions")).mode & 0o077).toBe(0);
    expect(statSync(join(home, "threads")).mode & 0o077).toBe(0);
  } finally {
    if (before === undefined) delete process.env.SPOOCHIE_HOME; else process.env.SPOOCHIE_HOME = before;
  }
});

/**
 * `writeFileSync` truncates and then writes: a process that dies in between leaves the
 * file cut short. In the config that cost the three keys and all the contacts (see
 * config.test.ts); in a thread, the conversation. It writes alongside and renames, which
 * on the same disk is atomic: a reader sees the whole old file or the whole new one.
 */
test("a state file is written whole or not at all", async () => {
  const { writeAtomic } = await import("../src/paths.ts");
  const { readFileSync, existsSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sp-atom-"));
  const f = join(dir, "state.json");

  writeAtomic(f, '{"a":1}');
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ a: 1 });
  writeAtomic(f, '{"a":2}');
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ a: 2 });
  // No temporary file is left behind.
  expect(existsSync(`${f}.nuevo`)).toBe(false);
  // And the mode is still for you only: inside are inbox tokens and keys.
  const { statSync } = await import("node:fs");
  expect(statSync(f).mode & 0o077).toBe(0);
});

test("and no state file is written with a bare writeFileSync any more", async () => {
  // If one shows up again, this test says so before it costs someone their contacts.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const suspects: string[] = [];
  for (const f of ["config.ts", "threads.ts", "outbox.ts", "registry.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", "src", f), "utf8");
    for (const [i, l] of source.split("\n").entries()) {
      if (/writeFileSync\(/.test(l) && !/\.nuevo|writeAtomic/.test(l)) suspects.push(`${f}:${i + 1}`);
    }
  }
  expect(suspects).toEqual([]);
});
