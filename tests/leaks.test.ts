import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plazo } from "./wait.ts";

/** Un repo de prueba con el comprobador dentro, para que `git ls-files` lo vea como en el real. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "sp-fugas-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_COMMITTER_NAME: "x" } });
  git("init", "-q");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(import.meta.dir, "..", "scripts", "leaks.ts"), join(dir, "scripts", "leaks.ts"));
  const commit = (msg: string, correo: string) => { git("add", "-A"); git("-c", `user.email=${correo}`, "-c", "user.name=x", "commit", "-q", "-m", msg); };
  const correr = (lista = "", desde?: string) => spawnSync("bun", ["scripts/leaks.ts", ...(desde ? ["--desde", desde] : [])], { cwd: dir, encoding: "utf8", env: { ...process.env, FUGAS_PROHIBIDAS: lista } });
  return { dir, git, commit, correr };
}

test("el comprobador de fugas deja pasar un repo limpio y para uno con ids, tokens, correos o palabras prohibidas", () => {
  const r = repo();
  writeFileSync(join(r.dir, "README.md"), "spoochie invite --to sam@example.com  # or --to U01234567\nnpub keys are fine: " + "npub1" + "x".repeat(58) + "\n");
  r.commit("Limpio", "yo@gmail.com");
  const ok = r.correr("acme,lopez");
  expect(ok.stdout + ok.stderr).toContain("nada en 1 commit");
  expect(ok.status).toBe(0);

  // Todo lo que no puede entrar, en un fichero, un nombre de fichero, un mensaje y un correo de autor.
  writeFileSync(join(r.dir, "notas.md"), [
    // Los datos de prueba se montan a trozos: el propio comprobador lee este fichero.
    "el id de Ana es U0" + "9ABCDE7XYZ",
    "token xoxb-" + "1234567890-ABCDEFGHIJKLMN-abcdefghijklmnop",
    "clave " + "0123456789abcdef".repeat(4),
    "escribe a ana@" + "acme-corp.com",
    "lo dijo Lopez en la reunion",
  ].join("\n"));
  writeFileSync(join(r.dir, "para-lopez.md"), "hola\n");
  r.commit("Notas de la reunion con ACME", "yo@" + "acme-corp.com");
  const mal = r.correr("acme,lopez", r.git("rev-parse", "HEAD~1").trim());
  expect(mal.status).toBe(1);
  const salida = mal.stderr;
  expect(salida).toContain("notas.md:1: id de Slack real");
  expect(salida).toContain("notas.md:2: token de Slack");
  expect(salida).toContain("notas.md:3: clave hex de 64");
  expect(salida).toContain("notas.md:4: correo fuera de la lista (acme-corp.com)");
  expect(salida).toContain("notas.md:4: palabra prohibida n.º 1");
  expect(salida).toContain("notas.md:5: palabra prohibida n.º 2");
  expect(salida).toContain("para-lopez.md: palabra prohibida n.º 2 en el nombre del fichero");
  expect(salida).toMatch(/commit [0-9a-f]{7} \(mensaje\):1: palabra prohibida n.º 1/);
  expect(salida).toMatch(/commit [0-9a-f]{7}: autor con correo fuera de la lista \(acme-corp.com\)/);
  // El informe nunca escribe la palabra prohibida.
  expect(salida.toLowerCase()).not.toContain("lopez.md: palabra prohibida n.º 2 en el nombre del fichero: lopez");
  expect(salida).not.toContain("acme,lopez");
}, plazo(20_000));
