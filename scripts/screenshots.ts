#!/usr/bin/env bun
/**
 * Capturas de la UI de verdad.
 *
 * "Los tests pasan" no es una prueba de que algo se ve bien. El aviso y la ventana del
 * Claude aparte son las dos cosas que ve una persona, y no habia una sola imagen de
 * ninguna de las dos en ningun sitio: se revisaban abriendolas a mano y mirando, o no se
 * revisaban.
 *
 *   bun scripts/screenshots.ts [--dir <destino>] [--pantalla-entera]
 *
 * Solo macOS, porque es donde existen las dos.
 *
 * EL AVISO se captura solo. La ventana se planta en un sitio conocido con
 * SPOOCHIE_WINDOW_POS, dice su alto por stdout, y `screencapture -R` recorta ese
 * rectangulo. En el PNG no cabe nada mas que la ventana.
 *
 * Antes no era asi, y por eso esta escrito: capturar una ventana por su id exige el
 * permiso de Accesibilidad de macOS, asi que la primera version capturaba la pantalla
 * entera y recortaba al centro. Medido dos veces: el primer intento se llevo el dialogo
 * del propio permiso, y el segundo el escritorio de quien lo corria, con las ventanas
 * que tuviera abiertas. En una herramienta cuyo argumento entero es que las cosas no se
 * escapan, eso no podia quedarse.
 *
 * LA VENTANA DEL APARTE sigue siendo una Terminal, que no se puede plantar donde
 * queramos, asi que esa si es pantalla entera recortada al centro. Va detras de
 * `--pantalla-entera` y con el aviso de mirar el PNG antes de ensenarlo.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowScript } from "../src/dialog.ts";
import { WIDTH } from "../src/window.ts";
import { firstTurn } from "../src/aside.ts";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIR = arg("dir") ?? join(process.cwd(), "capturas");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

if (process.platform !== "darwin") {
  console.error("las capturas son de la UI de macOS: el aviso y la ventana del aparte solo existen ahi");
  process.exit(1);
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

console.log(`capturas en ${DIR}\n`);

// 1. El aviso, recortado a su propio rectangulo.
{
  // MARCO = 0: el recorte es el rectangulo exacto de la ventana. Con margen se ve la
  // sombra, que queda mejor, pero tambien se ve una tira de lo que haya detras, y con
  // 8 pt esa tira ya traia texto legible de otra aplicacion. La sombra no es el diseno.
  const X = 200, Y = 160, MARCO = 0;
  // La posicion la lee `guionVentana` de este proceso, no del hijo: el guion sale ya
  // escrito con las coordenadas dentro. Ponerla solo en el env del spawn dejaba la
  // ventana centrada, y el recorte cogia lo que hubiera en esa esquina.
  process.env.SPOOCHIE_WINDOW_POS = `${X},${Y}`;
  const p = spawn("osascript", ["-l", "JavaScript", "-e", windowScript(HILO)], { stdio: ["ignore", "pipe", "pipe"] });
  let salida = "";
  p.stdout.on("data", d => { salida += d.toString(); });
  p.stderr.on("data", d => { salida += d.toString(); });
  // El alto lo dice la propia ventana cuando ya esta pintada.
  let alto = 0;
  for (let i = 0; i < 60 && !alto; i++) {
    await sleep(100);
    alto = Number(salida.match(/alto:(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  }
  if (!alto) {
    console.error(`  1-aviso        FALLO: la ventana no arranco${salida ? `: ${salida.trim().split("\n")[0]}` : ""}`);
  } else {
    await sleep(600); // que termine de aparecer y de aplicar el cristal
    const destino = join(DIR, "1-aviso.png");
    const r = spawnSync("screencapture", ["-x", "-R", `${X - MARCO},${Y - MARCO},${WIDTH + MARCO * 2},${Math.ceil(alto) + MARCO * 2}`, destino]);
    console.log(r.status === 0 && existsSync(destino) ? `  1-aviso        la ventana del aviso, ${WIDTH}x${Math.round(alto)}` : "  1-aviso        FALLO al recortar");
  }
  p.kill();
  await sleep(500);
}

// 2. La ventana del aparte: una Terminal con el primer turno dentro. No se lanza un
// Claude de verdad (costaria dinero y tardaria); se pinta lo que ve la persona al
// abrirse la ventana, que es lo que hay que revisar.
if (!process.argv.includes("--pantalla-entera")) {
  console.log(`  2-aparte       saltada. Es una Terminal, y una Terminal no se puede plantar donde`);
  console.log(`                 queramos: hay que capturar la pantalla entera y recortar al centro,`);
  console.log(`                 asi que lo que tengas detras acaba en el PNG. Cierra lo que no`);
  console.log(`                 quieras que salga y vuelve con --pantalla-entera.`);
} else {
  const guion = join(tmpdir(), "sp-cap-aparte.command");
  const turno = firstTurn(HILO, "S", "spoochie", process.cwd(), process.cwd());
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
  const entera = join(tmpdir(), "sp-cap-aparte.png");
  spawnSync("screencapture", ["-x", entera]);
  const destino = join(DIR, "2-aparte.png");
  const r = spawnSync("sips", ["-c", "1100", "1500", entera, "--out", destino], { stdio: "ignore" });
  console.log(r.status === 0 && existsSync(destino) ? `  2-aparte       la ventana con el primer turno` : "  2-aparte       FALLO");
  console.log(`\n  MIRA 2-aparte.png antes de ensenarselo a nadie: es de la pantalla entera.`);
  await sleep(500);
}

console.log(`\nEl transcript no se captura aqui: es un HTML que se publica como Artifact y`);
console.log(`se mira en el navegador. \`spoochie transcript <id>\` deja la ruta.`);
