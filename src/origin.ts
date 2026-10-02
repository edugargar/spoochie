/**
 * De donde viene esta copia de spoochie: el repo de GitHub del que se instala el plugin
 * y se descargan los binarios, y el nombre del marketplace. Grabado en un fichero para
 * que un fork solo tenga que tocar este, y con SPOOCHIE_ORIGEN por si alguien quiere
 * apuntar a su copia sin tocar nada.
 *
 * Formato: "dueño/repo" en GitHub. El marketplace se llama como el dueño.
 */
export const ORIGIN: string = (process.env.SPOOCHIE_ORIGIN ?? process.env.SPOOCHIE_ORIGEN) ?? "edugargar/spoochie";
export const OWNER = ORIGIN.split("/")[0];
export const PLUGIN = `spoochie@${OWNER}`;
