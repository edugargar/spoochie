// Los tests no tocan tu ~/.claude real.
// Ojo: os.homedir() en Bun NO respeta $HOME, asi que aislar por HOME no vale.
// El aislamiento va por SPOOCHIE_HOME, que es lo que lee src/paths.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SPOOCHIE_HOME = mkdtempSync(join(tmpdir(), "spoochie-test-"));
// Y no abren dialogos de macOS: el aviso va a la terminal salvo que un test diga otra cosa.
process.env.SPOOCHIE_AVISO ??= "terminal";
// Ni miran GitHub para ver si hay version nueva, ni copian el repo para el aparte.
process.env.SPOOCHIE_SIN_RED = "1";

/**
 * El plazo por defecto de los tests, y por que no son los 5 s de bun.
 *
 * Aqui hay muchos tests que lanzan procesos de verdad: demonios, git, osascript. Con la
 * maquina cargada, cinco segundos no dan. Medido: `copia.test.ts` fallaba a los 5.037 ms,
 * o sea justo en el corte, y el mensaje no decia "esto tarda mas", decia "esto no pasa".
 *
 * Los plazos que cada test declara ya pasaban por `plazo()`, pero un test que no declara
 * ninguno se quedaba con los 5 s de bun, y esos no los movia SPOOCHIE_TEST_LENTO. O sea
 * que el mando de la maquina lenta seguia sin llegar a todo.
 */
import { setDefaultTimeout } from "bun:test";
import { plazo } from "./espera.ts";
setDefaultTimeout(plazo(20_000));
