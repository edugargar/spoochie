import { expect, test } from "bun:test";

test("launchd no se degrada: una ruta de plugin mas vieja no sustituye a una mas nueva", async () => {
  const { versionFromPath, isNewer } = await import("../src/startup.ts");
  expect(versionFromPath("<string>/Users/x/.claude/plugins/cache/edugargar/spoochie/0.5.1/src/daemon.ts</string>")).toBe("0.5.1");
  expect(versionFromPath("/Users/x/Desktop/spoochie/src/daemon.ts")).toBeNull();
  expect(isNewer("0.5.2", "0.5.1")).toBe(true);
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("0.5.1", "0.5.1")).toBe(false);
});

test("el estado de ~/.claude/spochie se muda a spoochie una vez, y no pisa lo que ya hay", async () => {
  const { migrateState } = await import("../src/paths.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "sp-mig-"));
  const viejo = join(base, "spochie"), nuevo = join(base, "spoochie");
  mkdirSync(viejo); writeFileSync(join(viejo, "config.json"), '{"human":"Edu"}');
  expect(migrateState(viejo, nuevo)).toBe(true);
  expect(existsSync(viejo)).toBe(false);
  expect(readFileSync(join(nuevo, "config.json"), "utf8")).toContain("Edu");
  // Segunda vez: nada que mover. Y si hubiera algo nuevo, no se toca.
  expect(migrateState(viejo, nuevo)).toBe(false);
  mkdirSync(viejo); writeFileSync(join(viejo, "config.json"), "{}");
  expect(migrateState(viejo, nuevo)).toBe(false);
  expect(readFileSync(join(nuevo, "config.json"), "utf8")).toContain("Edu");
});

test("el latido lleva la version del demonio, y doctor la compara con la del plugin", async () => {
  const { beat, heartbeatVersion, HEARTBEAT } = await import("../src/startup.ts");
  const { readFileSync } = await import("node:fs");
  beat("0.7.1");
  expect(heartbeatVersion()).toBe("0.7.1");
  beat("0.9.1");
  expect(readFileSync(HEARTBEAT, "utf8")).toBe("0.9.1");
  // Un latido de un demonio anterior a 0.9.1 esta vacio: doctor no puede saber su version.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(HEARTBEAT, "");
  expect(heartbeatVersion()).toBeNull();
});

test("un demonio suelto y mas viejo que el plugin se detecta y se apaga esperando a que suelte el candado", async () => {
  const { stopDaemon, daemonBehind, pidAlive, beat, HEARTBEAT } = await import("../src/startup.ts");
  const { DAEMON_LOCK } = await import("../src/paths.ts");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, existsSync } = await import("node:fs");
  // Un proceso que hace de demonio viejo: suelto (su padre ya no es este test, como el
  // de un hook), con el candado, y late sin version (anterior a 0.9.1).
  const pid = Number(execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  writeFileSync(DAEMON_LOCK, String(pid));
  writeFileSync(HEARTBEAT, "");
  expect(pidAlive()).toBe(pid);
  expect(daemonBehind()).toBe(true);
  // Con la version de este plugin en el latido, no esta atrasado.
  beat();
  expect(daemonBehind()).toBe(false);
  beat("0.7.1");
  expect(daemonBehind()).toBe(true);
  const t0 = Date.now();
  expect(stopDaemon()).toBe(true);
  expect(Date.now() - t0).toBeLessThan(3000);
  await new Promise(r => setTimeout(r, 100));
  expect(pidAlive()).toBeNull();
  // Sin nadie con el candado, no hay nada que apagar.
  expect(stopDaemon()).toBe(false);
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
    const { wantedPlist } = await import("../src/startup.ts");
    const f = join(mkdtempSync(join(tmpdir(), "sp-plist-")), "p.plist");
    const texto = wantedPlist();
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
  const { agentPath } = await import("../src/startup.ts");
  const p = agentPath(["/opt/homebrew/bin/bun", "run", "daemon.ts"]);
  expect(p.split(":")[0]).toBe("/opt/homebrew/bin");
  expect(p).toContain("/usr/bin");
  // Nada temporal del shell de quien lo instalo.
  expect(agentPath(["/usr/bin/bun"], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(agentPath(["bun", "run", "x"], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
});

/**
 * El demonio tiene que poder encontrar `claude`.
 *
 * 0.9.9 dejo el PATH del LaunchAgent en "directorios del sistema y el de bun", y el
 * instalador nativo de Claude Code pone `claude` en ~/.local/bin. Resultado, el 01-10 en
 * la maquina de Edu: acepta un spoochie de Javi, se abre la ventana del aparte y dice
 * `exec: claude: not found`; en segundo plano, `Executable not found in $PATH: "claude"`.
 * Ningun spoochie aceptado se podia atender. Los tests no lo vieron porque usan un
 * `claude` falso puesto en el PATH del propio test.
 */
test("el PATH del agente incluye el directorio donde vive claude, y nada mas de fuera del sistema", async () => {
  const { agentPath, findClaude } = await import("../src/startup.ts");
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const casa = mkdtempSync(join(tmpdir(), "sp-claude-"));
  const bin = join(casa, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho ok\n"); chmodSync(join(bin, "claude"), 0o755);
  // Un directorio con un fichero `claude` que NO es ejecutable no cuenta.
  const tieso = join(casa, "tieso"); mkdirSync(tieso);
  writeFileSync(join(tieso, "claude"), "x");

  expect(findClaude([tieso, "/no/existe", bin])).toBe(bin);
  expect(findClaude([tieso, "/no/existe"])).toBeNull();

  const path = agentPath(["/usr/local/bin/bun", "run", "x"], undefined, bin);
  expect(path.split(":")).toContain(bin);
  // Y desde ese PATH, un shell de verdad lo encuentra.
  const r = (await import("node:child_process")).spawnSync("/bin/sh", ["-c", "command -v claude"], { env: { PATH: path }, encoding: "utf8" });
  expect(r.stdout.trim()).toBe(join(bin, "claude"));
  // Sin claude a la vista, el PATH es el de antes: no se inventa ningun directorio.
  expect(agentPath(["/usr/local/bin/bun"], undefined, null)).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

test("doctor falla si el PATH del demonio no encuentra claude, y dice como se arregla", async () => {
  const { claudeCheck } = await import("../src/doctor.ts");
  const { findClaude } = await import("../src/startup.ts");
  // Lo que tenia el plist de la 0.9.9 en la maquina de Edu.
  const malo = claudeCheck("/Users/x/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", () => null)!;
  expect(malo.ok).toBe(false);
  expect(malo.detalle).toContain("no esta en");
  expect(malo.detalle).toContain("spoochie register");
  expect(claudeCheck("/a:/b", d => (d.includes("/b") ? "/b" : null))).toMatchObject({ ok: true, detalle: "/b/claude" });
  // Sin LaunchAgent no hay PATH de demonio que mirar, y no se inventa un fallo.
  expect(claudeCheck(null, findClaude)).toBeNull();
});
