/** La version de esta copia de spoochie, la misma que ve el plugin. Bun mete el JSON en
 *  el binario compilado, asi que vale igual desde el fuente y desde la release. */
import plugin from "../.claude-plugin/plugin.json";
export const VERSION: string = plugin.version;

/** major.minor: dos versiones de la misma linea se entienden; el parche no importa. */
export const versionLine = (v: string) => v.split(".").slice(0, 2).join(".");
export function newerThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
