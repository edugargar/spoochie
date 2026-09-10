/**
 * El portero: juzga cada Bash del Claude aparte mirando los argumentos de verdad.
 *
 * Por que existe. `--allowedTools` casa por prefijo y no mira lo que viene detras, asi
 * que `Bash(git diff:*)` deja pasar `git diff --output=fichero`, que escribe. El
 * comentario de `herramientasPermitidas` lo admitia como precio asumido. Un hook
 * `PreToolUse` recibe la linea entera antes de ejecutarla y puede decir que no, que es
 * la unica forma de convertir esa suposicion en un control.
 *
 * La regla es de lista blanca y en este orden: ningun metacaracter de shell fuera de
 * comillas, cabecera conocida (git, la CLI de spoochie, o rtk delante de una de las
 * dos), subcomando de lectura, y ninguna bandera que escriba, que lea fuera del repo o
 * que ejecute otro programa. Lo que no se entiende no pasa.
 *
 * El texto de un mensaje si puede llevar `;` o `&&`: van dentro de comillas y el
 * escaner respeta las comillas, porque el shell tambien las respeta. Lo que no se
 * permite nunca, ni entre comillas dobles, es lo que el shell expande igualmente:
 * `$(...)` y las comillas invertidas.
 */

import { resolve, relative, isAbsolute } from "node:path";

export type Veredicto = { ok: true } | { ok: false; por: string };

/** Si una ruta cae dentro del directorio del aparte. `..` y las absolutas de fuera, no. */
export function dentro(base: string, ruta: string): boolean {
  if (!base) return true;
  // La tilde la expande el shell, no nosotros: `resolve("/repo", "~/x")` daria
  // "/repo/~/x", que parece de dentro y no lo es. Un repo no se llama "~".
  if (ruta.startsWith("~")) return false;
  const r = relative(resolve(base), resolve(base, ruta));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Las banderas de la CLI de spoochie que abren un fichero del disco y lo mandan por el
 *  tunel. `spoochie say v1 --file ~/.ssh/id_rsa` era una linea que la lista blanca
 *  aprobaba entera: el subcomando es `say`, que esta permitido. */
const SP_BANDERAS_DE_FICHERO = ["--file", "--files", "--diff-file"];

/** Subcomandos de git que solo leen. `branch` entra aparte: a secas admite -D y -f. */
const GIT_LECTURA = new Set(["diff", "log", "show", "status", "blame", "grep", "ls-files", "branch"]);

/** Banderas de git que escriben, leen fuera del repo o ejecutan otro programa. */
const GIT_BANDERAS_MALAS: Record<string, string> = {
  "-o": "escribe la salida en un fichero",
  "--output": "escribe la salida en un fichero",
  "--output-directory": "escribe la salida en un directorio",
  "--no-index": "compara ficheros de fuera del repo",
  "--ext-diff": "ejecuta el diff externo que diga la configuracion",
  "--textconv": "ejecuta el filtro que diga la configuracion",
  "-O": "abre los ficheros en el pager",
  "--open-files-in-pager": "abre los ficheros en el pager",
};

/** Opciones globales de git (las de antes del subcomando) que cambian donde mira o
 *  que ejecutan algo. `-C` es la que saca a git del worktree del aparte. */
const GIT_GLOBALES_MALAS: Record<string, string> = {
  "-c": "inyecta configuracion, y la configuracion de git ejecuta programas",
  "--config-env": "inyecta configuracion desde el entorno",
  "-C": "saca a git del directorio del aparte",
  "--git-dir": "apunta a otro repositorio",
  "--work-tree": "apunta a otro arbol de trabajo",
  "--exec-path": "cambia de donde salen los binarios de git",
  "--upload-pack": "ejecuta el programa que se le diga",
  "--receive-pack": "ejecuta el programa que se le diga",
  "--namespace": "cambia el espacio de nombres de las referencias",
};

/** `git branch` solo para listar: lo demas borra, mueve o fuerza. */
const GIT_BRANCH_BANDERAS = new Set(["--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--contains", "--no-contains", "--points-at", "--format", "--sort", "--merged", "--no-merged", "--color", "--no-color", "--column", "--no-column"]);

/** Lo que el aparte puede pedirle a su propia CLI. */
const SP_SUBCOMANDOS = new Set(["say", "patch", "branch", "show", "list", "close", "transcript"]);

type Escaneo = { palabras: string[]; problema?: string };

/**
 * Parte la linea en palabras como lo haria el shell, y para en cuanto ve algo que
 * encadena, redirige o sustituye. Devuelve las palabras ya sin comillas, que es lo que
 * le llegaria al programa.
 */
export function escanear(cmd: string): Escaneo {
  const palabras: string[] = [];
  let act = "", abierta = false;
  let modo: "libre" | "simple" | "doble" = "libre";
  const corta = (problema: string): Escaneo => ({ palabras, problema });

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], sig = cmd[i + 1];

    if (modo === "simple") {
      if (c === "'") { modo = "libre"; continue; }
      act += c; continue;
    }

    if (modo === "doble") {
      if (c === '"') { modo = "libre"; continue; }
      if (c === "\\" && sig !== undefined) { act += sig; i++; continue; }
      if (c === "`") return corta("una comilla invertida dentro de comillas dobles");
      if (c === "$" && sig === "(") return corta("una sustitucion $(...) dentro de comillas dobles");
      act += c; continue;
    }

    if (c === "\\") {
      if (sig === undefined) return corta("una barra invertida al final");
      act += sig; i++; abierta = true; continue;
    }
    if (c === "'") { modo = "simple"; abierta = true; continue; }
    if (c === '"') { modo = "doble"; abierta = true; continue; }
    if (c === "`") return corta("una comilla invertida");
    if (c === "$" && sig === "(") return corta("una sustitucion $(...)");
    if (c === ";" || c === "&" || c === "|" || c === ">" || c === "<" || c === "\n") return corta(`el metacaracter ${JSON.stringify(c)} fuera de comillas`);
    if (c === " " || c === "\t") { if (abierta) { palabras.push(act); act = ""; abierta = false; } continue; }
    act += c; abierta = true;
  }

  if (modo !== "libre") return corta("unas comillas sin cerrar");
  if (abierta) palabras.push(act);
  return { palabras };
}

/** El nombre de una bandera, sin su valor: `--output=x` es `--output`. */
const nombreBandera = (p: string) => p.startsWith("--") && p.includes("=") ? p.slice(0, p.indexOf("=")) : p;

function juzgarGit(resto: string[]): Veredicto {
  // Opciones globales antes del subcomando.
  let i = 0;
  while (i < resto.length && resto[i].startsWith("-")) {
    const n = nombreBandera(resto[i]);
    const por = GIT_GLOBALES_MALAS[n];
    if (por) return { ok: false, por: `\`git ${n}\` ${por}` };
    // Una global desconocida antes del subcomando no se adivina.
    if (n !== "--no-pager" && n !== "-P" && n !== "--literal-pathspecs" && n !== "--no-replace-objects") {
      return { ok: false, por: `no reconozco la opcion global \`git ${n}\`` };
    }
    i++;
  }

  const sub = resto[i];
  if (!sub) return { ok: false, por: "git sin subcomando" };
  if (!GIT_LECTURA.has(sub)) return { ok: false, por: `\`git ${sub}\` no esta entre los subcomandos de lectura` };

  const args = resto.slice(i + 1);
  for (const a of args) {
    const n = nombreBandera(a);
    const por = GIT_BANDERAS_MALAS[n];
    if (por) return { ok: false, por: `\`${n}\` ${por}` };
    // -o pegado a su valor (-o/tmp/x) no es una forma que git acepte, pero -O si.
    if (a.startsWith("-o") && a.length > 2 && !a.startsWith("--")) return { ok: false, por: "`-o` escribe la salida en un fichero" };
  }

  if (sub === "branch") {
    const banderas = args.filter(a => a.startsWith("-"));
    if (!banderas.some(a => nombreBandera(a) === "--list")) return { ok: false, por: "`git branch` solo con `--list`: a secas admite -D y -f" };
    for (const a of banderas) {
      if (!GIT_BRANCH_BANDERAS.has(nombreBandera(a))) return { ok: false, por: `\`git branch ${nombreBandera(a)}\` no solo lista` };
    }
  }

  return { ok: true };
}

function juzgarSpoochie(resto: string[], cwd: string): Veredicto {
  const sub = resto[0];
  if (!sub) return { ok: false, por: "spoochie sin subcomando" };
  if (!SP_SUBCOMANDOS.has(sub)) return { ok: false, por: `\`spoochie ${sub}\` no es de las que puede correr el aparte` };

  for (let i = 1; i < resto.length; i++) {
    const n = nombreBandera(resto[i]);
    if (!SP_BANDERAS_DE_FICHERO.includes(n)) continue;
    const valor = resto[i].includes("=") ? resto[i].slice(resto[i].indexOf("=") + 1) : resto[i + 1];
    if (!valor || valor === "-") continue;
    for (const ruta of valor.split(",").map(x => x.trim()).filter(Boolean)) {
      if (!dentro(cwd, ruta)) return { ok: false, por: `\`${n} ${ruta}\` saca por el tunel un fichero de fuera de este repo` };
    }
  }
  return { ok: true };
}

/**
 * El veredicto sobre una linea de Bash. `cli` es como se invoca la CLI de spoochie en
 * esta maquina, que puede ser una palabra (binario compilado) o tres (`bun run cli.ts`).
 */
export function juzgarBash(cmd: string, cli: string, cwd = ""): Veredicto {
  const { palabras, problema } = escanear(cmd);
  if (problema) return { ok: false, por: `la linea lleva ${problema}` };
  if (!palabras.length) return { ok: false, por: "una linea vacia" };

  const cabeceraCli = escanear(cli).palabras;
  let p = palabras;

  // rtk delante: el proxy reescribe el comando, lo que va detras es lo que importa.
  if (p[0] === "rtk") p = p.slice(1);
  if (!p.length) return { ok: false, por: "rtk sin comando detras" };

  if (cabeceraCli.length && p.length >= cabeceraCli.length && cabeceraCli.every((w, n) => p[n] === w)) {
    return juzgarSpoochie(p.slice(cabeceraCli.length), cwd);
  }
  if (p[0] === "git") return juzgarGit(p.slice(1));

  return { ok: false, por: `\`${p[0]}\` no esta entre lo que puede correr el aparte (git de lectura y spoochie)` };
}

/** Lo que el hook escribe en su salida estandar. */
export type Decision = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
};

const decision = (permissionDecision: "allow" | "deny", permissionDecisionReason: string): Decision =>
  ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } });

/**
 * El hook entero, de la entrada de Claude Code al veredicto. Lo que no sea Bash se deja
 * pasar sin opinar: de eso se encargan la lista blanca y las denegaciones duras.
 */
export function portero(entrada: unknown, cli: string): Decision {
  const e = entrada as { tool_name?: string; cwd?: string; tool_input?: Record<string, unknown> } | null;
  if (!e || typeof e !== "object") return decision("deny", "spoochie: no entiendo la entrada del hook");
  const cwd = typeof e.cwd === "string" ? e.cwd : "";

  // Leer fuera del directorio del aparte. El aparte trabaja en una copia limpia del
  // repo; su lista de herramientas lleva Read, Grep y Glob sin acotar, asi que podia
  // leer ~/.ssh o el .env de otro proyecto y contarlo por el tunel.
  if (["Read", "Grep", "Glob", "NotebookRead"].includes(e.tool_name ?? "")) {
    for (const campo of ["file_path", "path", "notebook_path"]) {
      const v = e.tool_input?.[campo];
      if (typeof v === "string" && v && !dentro(cwd, v)) {
        return decision("deny", `spoochie: ${v} esta fuera del repo que atiende este spoochie. Este Claude solo lee lo de aqui; si necesitas algo de fuera, pidelo por el tunel y que lo mire la persona.`);
      }
    }
    return decision("allow", "");
  }

  if (e.tool_name !== "Bash") return decision("allow", "");

  const cmd = e.tool_input?.command;
  if (typeof cmd !== "string") return decision("deny", "spoochie: un Bash sin comando");

  const v = juzgarBash(cmd, cli, cwd);
  return v.ok
    ? decision("allow", "")
    : decision("deny", `spoochie: este Claude atiende un tunel y solo lee. No paso porque ${v.por}. Si necesitas eso, dilo por el tunel con \`spoochie say\` y que lo haga la persona del otro lado.`);
}
