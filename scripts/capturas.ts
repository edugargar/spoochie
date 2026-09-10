#!/usr/bin/env bun
/**
 * Capturas de la UI de verdad.
 *
 * "Los tests pasan" no es una prueba de que algo se ve bien. El dialogo del sistema y la
 * ventana del Claude aparte son las dos cosas que ve una persona, y no habia una sola
 * imagen de ninguna de las dos en ningun sitio: se revisaban abriendolas a mano y
 * mirando, o no se revisaban.
 *
 *   bun scripts/capturas.ts --pantalla-entera [--dir <destino>]
 *
 * Solo macOS, porque es donde existen las dos.
 *
 * EL AVISO, que es la parte importante. Esto captura la PANTALLA ENTERA y recorta al
 * centro. No captura la ventana: para eso hacen falta sus coordenadas, y pedirlas pasa
 * por System Events, que dispara el permiso de Accesibilidad de macOS y ademas deja el
 * dialogo del permiso en medio de la propia captura. Medido: el primer intento capturo
 * ese dialogo, y el segundo capturo el escritorio de quien lo corria, con las ventanas
 * que tuviera abiertas.
 *
 * O sea que este script mete en un PNG lo que tengas en pantalla. En una herramienta
 * cuyo argumento entero es que las cosas no se escapan, eso no puede pasar por defecto:
 * hay que pedirlo con `--pantalla-entera`, y al terminar se recuerda mirar las imagenes
 * antes de ensenarselas a nadie.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guionOsascript } from "../src/dialogo.ts";
import { primerTurno } from "../src/aparte.ts";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIR = arg("dir") ?? join(process.cwd(), "capturas");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

if (process.platform !== "darwin") {
  console.error("las capturas son de la UI de macOS: el dialogo y la ventana del aparte solo existen ahi");
  process.exit(1);
}
if (!process.argv.includes("--pantalla-entera")) {
  console.error("Esto captura la PANTALLA ENTERA y recorta al centro, porque capturar solo la");
  console.error("ventana exige el permiso de Accesibilidad de macOS (y el dialogo del permiso");
  console.error("sale en la propia captura). Lo que tengas abierto detras acaba en el PNG.");
  console.error("");
  console.error("Cierra lo que no quieras que salga y vuelve con:");
  console.error("  bun scripts/capturas.ts --pantalla-entera [--dir <destino>]");
  process.exit(2);
}
mkdirSync(DIR, { recursive: true });

/** El hilo de ejemplo. Uno realista, no "asunto de prueba": una captura vale por lo que
 *  ensena, y un caso vacio no ensena si el texto largo se corta bien. */
const HILO: any = {
  id: "k7f",
  subject: "el guardado del modal devuelve 500 en tu rama",
  from: { sessionId: "slack:U1", name: "sam", human: "Sam", cwd: "/x" },
  to: { sessionId: "S", name: "anthias", cwd: process.cwd(), human: "Edu" },
  context: { branch: "fix/modal-save", files: ["src/modal.tsx", "src/api/save.ts", "tests/modal.test.ts"] },
  state: "open",
  messages: [{ at: Date.now(), from: "slack:U1", author: "claude", kind: "text", text: "Al guardar me sale un 500 sin traza. En main funciona. Es cosa de tu rama o mia?" }],
};

async function capturar(nombre: string, alto: number, ancho: number) {
  const entera = join(tmpdir(), `sp-cap-${nombre}.png`);
  spawnSync("screencapture", ["-x", entera]);
  const destino = join(DIR, `${nombre}.png`);
  const r = spawnSync("sips", ["-c", String(alto), String(ancho), entera, "--out", destino], { stdio: "ignore" });
  if (r.status !== 0 || !existsSync(destino)) { console.error(`  no pude recortar ${nombre}`); return null; }
  return destino;
}

console.log(`capturas en ${DIR}\n`);

// 1. El aviso: el dialogo del sistema, tal cual lo ve quien recibe un spoochie.
{
  const p = spawn("osascript", ["-e", guionOsascript(HILO, 60)], { stdio: "ignore" });
  await sleep(3000);
  const f = await capturar("1-aviso", 1000, 1400);
  p.kill();
  spawnSync("pkill", ["osascript"]);
  console.log(f ? `  1-aviso        el dialogo con los tres botones` : "  1-aviso        FALLO");
  await sleep(1000);
}

// 2. La ventana del aparte: una Terminal con el primer turno dentro. No se lanza un
// Claude de verdad (costaria dinero y tardaria); se pinta lo que ve la persona al
// abrirse la ventana, que es lo que hay que revisar.
{
  const guion = join(tmpdir(), "sp-cap-aparte.command");
  const turno = primerTurno(HILO, "S", "spoochie", process.cwd(), process.cwd());
  writeFileSync(guion, [
    "#!/bin/sh",
    `printf '\\033]0;spoochie ${HILO.id}\\007'`,
    `echo 'spoochie ${HILO.id} · ${HILO.subject}'`,
    `echo 'Claude aparte: solo lectura + spoochie say. Puedes escribirle aqui. Cerrar la ventana cierra el spoochie.'`,
    `echo ''`,
    `cat <<'FIN'`,
    turno.split("\n").slice(0, 14).join("\n"),
    "FIN",
    "sleep 12",
    "",
  ].join("\n"), { mode: 0o700 });
  spawnSync("open", ["-a", "Terminal", guion]);
  await sleep(4000);
  const f = await capturar("2-aparte", 1100, 1500);
  console.log(f ? `  2-aparte       la ventana con el primer turno` : "  2-aparte       FALLO");
  await sleep(1000);
}

console.log(`\nMIRA LAS DOS IMAGENES antes de ensenarselas a nadie: son de la pantalla entera`);
console.log(`recortada al centro, asi que puede haber salido algo que tenias detras.`);
console.log(`\nEl transcript no se captura aqui: es un HTML que se publica como Artifact y`);
console.log(`se mira en el navegador. \`spoochie transcript <id>\` deja la ruta.`);
