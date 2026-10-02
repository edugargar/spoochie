#!/usr/bin/env bun
/**
 * Comprobador de fugas: lo que no puede entrar en un repo publico.
 *
 * Corre en CI en cada push y PR, y en local antes de cada push (.githooks/pre-push).
 * Mira tres cosas: el arbol en HEAD, los mensajes de los commits nuevos, y los correos
 * de autor y committer de esos commits.
 *
 *   bun scripts/leaks.ts [--desde <sha>]
 *
 * Lo que busca siempre: ids de Slack reales, tokens (Slack, GitHub, AWS, Anthropic,
 * Nostr nsec, claves privadas), claves hex de 64, y correos fuera de una lista corta de
 * dominios. Y ademas las palabras de FUGAS_PROHIBIDAS (separadas por comas, sin
 * distinguir mayusculas): nombres de personas, de empresa, de apps internas. La lista
 * no vive en el repo, porque estaria publicando lo que quiere ocultar: en CI es un
 * secreto de GitHub, en local un fichero fuera del repo. Cuando una de esas palabras
 * salta, el informe dice donde, no cual.
 *
 * Por que existe: el historial se reescribio una vez para sacar nombres y la empresa,
 * y el mismo dia un commit volvio a salir con el correo del trabajo. Un `git grep` a
 * mano no es un control.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

const CORREOS_PERMITIDOS = ["gmail.com", "users.noreply.github.com", "github.com", "anthropic.com", "example.com", "example.org"];
const BINARIOS = /\.(png|jpg|jpeg|gif|ico|pdf|woff2?|ttf|lock|zip|gz)$/i;

const PATRONES: [string, RegExp][] = [
  ["token de Slack", /xox[abpe]-[0-9A-Za-z]{8,}-[0-9A-Za-z-]{8,}/],
  ["token de GitHub", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["clave de AWS", /\bAKIA[0-9A-Z]{16}\b/],
  ["clave de Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["nsec de Nostr", /\bnsec1[a-z0-9]{50,}\b/],
  ["clave privada", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["clave hex de 64 (¿una clave real?)", /\b[0-9a-f]{64}\b/],
];
const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const prohibidas = (process.env.FUGAS_PROHIBIDAS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

type Hallazgo = { donde: string; que: string };
const hallazgos: Hallazgo[] = [];

function revisarTexto(texto: string, donde: string, conCorreos = true) {
  const lineas = texto.split("\n");
  lineas.forEach((l, i) => {
    for (const [que, re] of PATRONES) if (re.test(l)) hallazgos.push({ donde: `${donde}:${i + 1}`, que });
    // Un id de Slack real mezcla letras y cifras tras la U0; el de ejemplo de los docs es U01234567, solo cifras.
    for (const m of l.match(/\b[UDCGW]0[0-9A-Z]{7,10}\b/g) ?? []) if (/[A-Z]/.test(m.slice(1))) hallazgos.push({ donde: `${donde}:${i + 1}`, que: "id de Slack real" });
    if (conCorreos) for (const m of l.match(CORREO) ?? []) {
      const dominio = m.split("@")[1].toLowerCase();
      if (!CORREOS_PERMITIDOS.some(d => dominio === d || dominio.endsWith("." + d))) hallazgos.push({ donde: `${donde}:${i + 1}`, que: `correo fuera de la lista (${dominio})` });
    }
    const bajo = l.toLowerCase();
    prohibidas.forEach((p, n) => { if (bajo.includes(p)) hallazgos.push({ donde: `${donde}:${i + 1}`, que: `palabra prohibida n.º ${n + 1}` }); });
  });
}

// 1. El arbol en HEAD.
for (const f of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (BINARIOS.test(f)) continue;
  let texto: string;
  try { texto = readFileSync(f, "utf8"); } catch { continue; }
  if (texto.includes("\0")) continue;
  revisarTexto(texto, f);
  prohibidas.forEach((p, n) => { if (f.toLowerCase().includes(p)) hallazgos.push({ donde: f, que: `palabra prohibida n.º ${n + 1} en el nombre del fichero` }); });
}

// 2. Los commits nuevos: mensajes y correos.
const desde = arg("--desde");
const rango = desde && /^[0-9a-f]{7,40}$/.test(desde) && !/^0+$/.test(desde) ? `${desde}..HEAD` : "HEAD";
let commits: string[] = [];
try { commits = git("rev-list", rango).split("\n").filter(Boolean); } catch { commits = [git("rev-parse", "HEAD").trim()]; }
for (const sha of commits) {
  const [ae, ce, ...resto] = git("show", "-s", "--format=%ae%n%ce%n%B", sha).split("\n");
  const cuerpo = resto.join("\n");
  for (const [rol, correo] of [["autor", ae], ["committer", ce]]) {
    const dominio = correo.split("@")[1]?.toLowerCase() ?? "";
    if (!CORREOS_PERMITIDOS.some(d => dominio === d || dominio.endsWith("." + d))) hallazgos.push({ donde: `commit ${sha.slice(0, 7)}`, que: `${rol} con correo fuera de la lista (${dominio || "vacio"})` });
  }
  revisarTexto(cuerpo, `commit ${sha.slice(0, 7)} (mensaje)`);
}

if (hallazgos.length) {
  console.error(`fugas: ${hallazgos.length} hallazgo${hallazgos.length === 1 ? "" : "s"} en ${commits.length} commit${commits.length === 1 ? "" : "s"} y el arbol de HEAD`);
  for (const h of hallazgos) console.error(`  ${h.donde}: ${h.que}`);
  process.exit(1);
}
console.log(`fugas: nada en ${commits.length} commit${commits.length === 1 ? "" : "s"} ni en el arbol (${prohibidas.length} palabra${prohibidas.length === 1 ? "" : "s"} prohibida${prohibidas.length === 1 ? "" : "s"} en la lista)`);
