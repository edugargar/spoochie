/** The version of this copy of spoochie, the same one the plugin sees. Bun bakes the JSON
 *  into the compiled binary, so it works the same from source and from the release. */
import plugin from "../.claude-plugin/plugin.json";
export const VERSION: string = plugin.version;

/** major.minor: two versions on the same line understand each other; the patch does not matter. */
export const versionLine = (v: string) => v.split(".").slice(0, 2).join(".");
export function newerThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
