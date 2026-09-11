import { expect, test } from "bun:test";

test("launchd no se degrada: una ruta de plugin mas vieja no sustituye a una mas nueva", async () => {
  const { versionDeRuta, masNueva } = await import("../src/arranque.ts");
  expect(versionDeRuta("<string>/Users/x/.claude/plugins/cache/edugargar/spoochie/0.5.1/src/daemon.ts</string>")).toBe("0.5.1");
  expect(versionDeRuta("/Users/x/Desktop/spoochie/src/daemon.ts")).toBeNull();
  expect(masNueva("0.5.2", "0.5.1")).toBe(true);
  expect(masNueva("0.10.0", "0.9.9")).toBe(true);
  expect(masNueva("0.5.1", "0.5.1")).toBe(false);
});

test("el estado de ~/.claude/spochie se muda a spoochie una vez, y no pisa lo que ya hay", async () => {
  const { migrarEstado } = await import("../src/paths.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "sp-mig-"));
  const viejo = join(base, "spochie"), nuevo = join(base, "spoochie");
  mkdirSync(viejo); writeFileSync(join(viejo, "config.json"), '{"human":"Edu"}');
  expect(migrarEstado(viejo, nuevo)).toBe(true);
  expect(existsSync(viejo)).toBe(false);
  expect(readFileSync(join(nuevo, "config.json"), "utf8")).toContain("Edu");
  // Segunda vez: nada que mover. Y si hubiera algo nuevo, no se toca.
  expect(migrarEstado(viejo, nuevo)).toBe(false);
  mkdirSync(viejo); writeFileSync(join(viejo, "config.json"), "{}");
  expect(migrarEstado(viejo, nuevo)).toBe(false);
  expect(readFileSync(join(nuevo, "config.json"), "utf8")).toContain("Edu");
});

test("el latido lleva la version del demonio, y doctor la compara con la del plugin", async () => {
  const { latir, versionLatido, LATIDO } = await import("../src/arranque.ts");
  const { readFileSync } = await import("node:fs");
  latir("0.7.1");
  expect(versionLatido()).toBe("0.7.1");
  latir("0.9.1");
  expect(readFileSync(LATIDO, "utf8")).toBe("0.9.1");
  // Un latido de un demonio anterior a 0.9.1 esta vacio: doctor no puede saber su version.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(LATIDO, "");
  expect(versionLatido()).toBeNull();
});

test("un demonio suelto y mas viejo que el plugin se detecta y se apaga esperando a que suelte el candado", async () => {
  const { apagarDemonio, demonioAtrasado, pidVivo, latir, LATIDO } = await import("../src/arranque.ts");
  const { DAEMON_LOCK } = await import("../src/paths.ts");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, existsSync } = await import("node:fs");
  // Un proceso que hace de demonio viejo: suelto (su padre ya no es este test, como el
  // de un hook), con el candado, y late sin version (anterior a 0.9.1).
  const pid = Number(execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  writeFileSync(DAEMON_LOCK, String(pid));
  writeFileSync(LATIDO, "");
  expect(pidVivo()).toBe(pid);
  expect(demonioAtrasado()).toBe(true);
  // Con la version de este plugin en el latido, no esta atrasado.
  latir();
  expect(demonioAtrasado()).toBe(false);
  latir("0.7.1");
  expect(demonioAtrasado()).toBe(true);
  const t0 = Date.now();
  expect(apagarDemonio()).toBe(true);
  expect(Date.now() - t0).toBeLessThan(3000);
  await new Promise(r => setTimeout(r, 100));
  expect(pidVivo()).toBeNull();
  // Sin nadie con el candado, no hay nada que apagar.
  expect(apagarDemonio()).toBe(false);
  expect(existsSync(DAEMON_LOCK)).toBe(true);
});

/**
 * El plist es XML, y un plist mal formado lo rechaza launchd sin que nadie se entere.
 *
 * Las rutas se metian tal cual. Un directorio con `&` (uno llamado "copias & backups",
 * sin ir mas lejos) dejaba el fichero invalido: medido con `plutil -lint`, "Encountered
 * unknown ampersand-escape sequence". launchd no lo cargaba, `launchctl` fallaba en
 * silencio porque el `||` se tragaba los dos intentos, e `instalarLaunchd` devolvia
 * "instalado" igual. El sintoma era "no llega nada", que es exactamente lo que este
 * fichero existe para que no pase.
 */
test.if(process.platform === "darwin")("el plist sigue siendo XML valido con rutas raras", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const antes = process.env.SPOOCHIE_DAEMON_CMD;
  try {
    // `SPOOCHIE_DAEMON_CMD` parte por espacios (es el gancho de los tests), asi que el
    // directorio raro va sin ellos. Lo que se prueba es el escapado, no ese gancho.
    process.env.SPOOCHIE_DAEMON_CMD = "/opt/copias&backups/bin/bun run <daemon>.ts";
    const { plistDeseado } = await import("../src/arranque.ts");
    const f = join(mkdtempSync(join(tmpdir(), "sp-plist-")), "p.plist");
    const texto = plistDeseado();
    writeFileSync(f, texto);
    expect(texto).toContain("copias&amp;backups");
    expect(texto).toContain("&lt;daemon&gt;");
    const r = spawnSync("plutil", ["-lint", f], { encoding: "utf8" });
    expect((r.stdout + r.stderr).trim()).toEndWith("OK");
  } finally {
    if (antes === undefined) delete process.env.SPOOCHIE_DAEMON_CMD; else process.env.SPOOCHIE_DAEMON_CMD = antes;
  }
});

/**
 * Lo que se graba en el agente se queda ahi para siempre.
 *
 * Se metia `process.env.PATH` entero: el PATH del shell desde el que alguien corrio
 * `register` una vez. Puede traer el `bin` de un worktree, de un nix shell o de un test,
 * y el agente lo usa en cada arranque de la maquina. Un `bun` que aparezca ahi despues
 * lo ejecuta el demonio.
 */
test("el PATH del agente es el estable mas el del bun que se va a usar, no el del shell", async () => {
  const { pathDelAgente } = await import("../src/arranque.ts");
  const p = pathDelAgente(["/opt/homebrew/bin/bun", "run", "daemon.ts"]);
  expect(p.split(":")[0]).toBe("/opt/homebrew/bin");
  expect(p).toContain("/usr/bin");
  // Nada temporal del shell de quien lo instalo.
  expect(pathDelAgente(["/usr/bin/bun"], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(pathDelAgente(["bun", "run", "x"], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
});
