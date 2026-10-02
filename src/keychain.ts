/**
 * Los secretos en el llavero de macOS en vez de en un fichero de texto.
 *
 * `config.json` guarda la clave privada ed25519 con la que firmas, la clave secreta de
 * Nostr con la que se descifra todo lo que te mandan, y el token del bot del equipo.
 * Los tres en claro, protegidos solo por los permisos del fichero (0600). Eso significa
 * que cualquier proceso que corra como tu (una dependencia de npm, un script pegado de
 * internet, cualquier cosa) te suplanta leyendo un fichero.
 *
 * En el llavero no: sacarlos de ahi exige pasar por el sistema, que lo controla el
 * usuario. No es magia y no protege de todo, pero cambia "leer un fichero" por "pedirle
 * permiso al sistema", que es exactamente la diferencia que importa.
 *
 * Es opcional y se enciende a mano (`spoochie llavero on`). Una migracion automatica de
 * las claves de alguien es la clase de cosa que, si sale mal, deja a esa persona fuera
 * de su propia agenda sin forma de volver.
 */
import { execFileSync } from "node:child_process";

/** Lo que queda escrito en config.json en lugar del secreto. */
export const MARKER = "@llavero";

const SERVICIO = "spoochie";

export function available(): boolean {
  if (process.platform !== "darwin") return false;
  try { execFileSync("security", ["-h"], { stdio: "ignore" }); return true; } catch { return false; }
}

export function store(cuenta: string, secreto: string): boolean {
  try {
    // -U actualiza si ya estaba; -w lo pasa por argumento, que es lo que hace `security`.
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICIO, "-a", cuenta, "-w", secreto], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

export function read(cuenta: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICIO, "-a", cuenta, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

export function remove(cuenta: string): boolean {
  try { execFileSync("security", ["delete-generic-password", "-s", SERVICIO, "-a", cuenta], { stdio: "ignore" }); return true; } catch { return false; }
}

/** Los tres secretos que hay que mover, con el nombre con el que viven en el llavero. */
export const ACCOUNTS = { firma: "clave-de-firma", nostr: "clave-nostr", bot: "token-de-bot" } as const;
