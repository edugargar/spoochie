import { expect, test } from "bun:test";
import { escanear, juzgarBash, portero } from "../src/portero.ts";
import { ajustesAparte, banderasAparte, modoPermisos, scriptVentana, MODELO_APARTE, presupuestoAparte, PRESUPUESTO_APARTE } from "../src/aparte.ts";

const CLI = "/usr/local/bin/spoochie";
const CLI_DEV = "/opt/bun run /repo/src/cli.ts";

const pasa = (cmd: string, cli = CLI) => juzgarBash(cmd, cli).ok;
const porque = (cmd: string, cli = CLI) => { const v = juzgarBash(cmd, cli); return v.ok ? "" : v.por; };

test("el escaner respeta las comillas: un `;` dentro de un mensaje no es un metacaracter", () => {
  expect(escanear(`spoochie say v1 "arregla el modal; luego el boton"`).problema).toBeUndefined();
  expect(escanear(`spoochie say v1 "arregla el modal; luego el boton"`).palabras).toEqual([
    "spoochie", "say", "v1", "arregla el modal; luego el boton",
  ]);
  expect(escanear("git log; touch /tmp/x").problema).toContain('";"');
  expect(escanear(`git log 'a b'`).palabras).toEqual(["git", "log", "a b"]);
  expect(escanear(`git log "sin cerrar`).problema).toContain("sin cerrar");
});

test("lo que el shell expande igual entre comillas dobles no pasa", () => {
  expect(escanear(`spoochie say v1 "$(cat /etc/passwd)"`).problema).toContain("$(...)");
  expect(escanear('spoochie say v1 "`id`"').problema).toContain("comilla invertida");
  // Entre comillas simples el shell no expande nada, y el texto es solo texto.
  expect(escanear(`spoochie say v1 '$(cat /etc/passwd)'`).problema).toBeUndefined();
});

test("las formas de escribir que la lista blanca dejaba pasar", () => {
  // Las cinco de la sonda: `Bash(git diff:*)` casa por prefijo y no mira los argumentos.
  expect(pasa("git diff --output=/tmp/escrito.txt")).toBe(false);
  expect(porque("git diff --output=/tmp/escrito.txt")).toContain("escribe la salida");
  expect(pasa("git diff -o /tmp/escrito.txt")).toBe(false);
  expect(pasa("git format-patch -o /tmp")).toBe(false);
  expect(pasa("git log; touch /tmp/escrito.txt")).toBe(false);
  expect(pasa("git status && rm -rf /tmp/x")).toBe(false);
  expect(pasa("git log --ext-diff")).toBe(false);
  expect(pasa("git log | tee /tmp/escrito.txt")).toBe(false);
  expect(pasa("git log > /tmp/escrito.txt")).toBe(false);
});

test("las formas de leer fuera del repo tampoco", () => {
  expect(pasa("git diff --no-index /etc/passwd /etc/hosts")).toBe(false);
  expect(porque("git diff --no-index /etc/passwd /etc/hosts")).toContain("fuera del repo");
  expect(pasa("git -C /otro/repo log")).toBe(false);
  expect(porque("git -C /otro/repo log")).toContain("saca a git del directorio");
  expect(pasa("git --git-dir=/otro/.git log")).toBe(false);
  expect(pasa("git --work-tree=/otro log")).toBe(false);
});

test("la configuracion de git ejecuta programas, asi que -c no entra", () => {
  expect(pasa("git -c core.pager=id log")).toBe(false);
  expect(porque("git -c core.pager=id log")).toContain("configuracion");
  expect(pasa("git -c alias.x=!id x")).toBe(false);
  expect(pasa("git --exec-path=/tmp log")).toBe(false);
});

test("git branch solo lista", () => {
  expect(pasa("git branch --list")).toBe(true);
  expect(pasa("git branch --list -a")).toBe(true);
  expect(pasa("git branch")).toBe(false);
  expect(pasa("git branch -D main")).toBe(false);
  expect(pasa("git branch --list -D")).toBe(false);
  expect(porque("git branch -D main")).toContain("--list");
});

test("lo que el aparte si tiene que poder hacer sigue pasando", () => {
  expect(pasa("git diff HEAD~1")).toBe(true);
  expect(pasa("git log --oneline -20")).toBe(true);
  expect(pasa("git show HEAD:src/daemon.ts")).toBe(true);
  expect(pasa("git status")).toBe(true);
  expect(pasa("git grep -n modal -- src")).toBe(true);
  expect(pasa("git blame src/cli.ts")).toBe(true);
  expect(pasa("git ls-files")).toBe(true);
  expect(pasa("git --no-pager log -1")).toBe(true);
  expect(pasa(`${CLI} say v1 "es el min-width del contenedor"`)).toBe(true);
  expect(pasa(`${CLI} patch v1 --from-git`)).toBe(true);
  expect(pasa(`${CLI} close v1 --reason "resuelto"`)).toBe(true);
  expect(pasa(`${CLI_DEV} say v1 "hola"`, CLI_DEV)).toBe(true);
});

test("con rtk delante se juzga lo de detras, no el proxy", () => {
  expect(pasa("rtk git log --oneline")).toBe(true);
  expect(pasa("rtk git diff --output=/tmp/x")).toBe(false);
  expect(pasa(`rtk ${CLI} say v1 "hola"`)).toBe(true);
  expect(pasa("rtk")).toBe(false);
});

test("cualquier otro programa no entra, aunque parezca inofensivo", () => {
  expect(pasa("ls -la")).toBe(false);
  expect(pasa("cat src/cli.ts")).toBe(false);
  expect(pasa("bun test")).toBe(false);
  expect(pasa("curl https://example.com")).toBe(false);
  expect(porque("ls -la")).toContain("no esta entre lo que puede correr el aparte");
});

test("el aparte no puede correr subcomandos de spoochie que aceptan o sueltan", () => {
  expect(pasa(`${CLI} accept v1`)).toBe(false);
  expect(pasa(`${CLI} release v1`)).toBe(false);
  expect(pasa(`${CLI} open otro --subject x`)).toBe(false);
  expect(pasa(`${CLI} config --guardian off`)).toBe(false);
  expect(pasa(`${CLI} invite --to U0`)).toBe(false);
});

test("el hook deja pasar lo que no es Bash y niega lo que no entiende", () => {
  const r = (e: unknown) => portero(e, CLI).hookSpecificOutput;
  expect(r({ tool_name: "Read", tool_input: { file_path: "/x" } }).permissionDecision).toBe("allow");
  expect(r({ tool_name: "Bash", tool_input: { command: "git log" } }).permissionDecision).toBe("allow");
  expect(r({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }).permissionDecision).toBe("deny");
  expect(r({ tool_name: "Bash" }).permissionDecision).toBe("deny");
  expect(r(null).permissionDecision).toBe("deny");
  // La razon le dice al Claude aparte que haga lo unico que puede hacer: hablar.
  expect(r({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }).permissionDecisionReason).toContain("spoochie say");
});

test("el aparte arranca con el portero enganchado, en ventana y en fondo", () => {
  const a = ajustesAparte("/usr/local/bin/spoochie") as any;
  expect(a.crossSessionInbound).toBe("accept");
  expect(a.hooks.PreToolUse[0].matcher).toBe("Bash");
  expect(a.hooks.PreToolUse[0].hooks[0].command).toBe("/usr/local/bin/spoochie portero");
});

test("la ventana y el fondo arrancan con las mismas banderas", () => {
  // Estaban escritas dos veces y habian divergido: la ventana con modoPermisos() y el
  // fondo con "default" a mano. El script de la ventana lleva las banderas entrecomilladas
  // por sq(), asi que se comparan las palabras que salen de banderasAparte en los dos sitios.
  const b = banderasAparte("v1", "/usr/local/bin/spoochie");
  expect(b).toContain("--permission-mode");
  expect(b[b.indexOf("--permission-mode") + 1]).toBe(modoPermisos());
  expect(b[b.indexOf("--settings") + 1]).toBe(JSON.stringify(ajustesAparte("/usr/local/bin/spoochie")));

  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, context: {}, state: "open", messages: [] };
  const script = scriptVentana(t, "/tmp", "sesion-1");
  for (const palabra of banderasAparte("v1")) expect(script).toContain(palabra.split("\n")[0].slice(0, 40));
  expect(script).not.toContain("--permission-mode default\n");
});

test("el aparte contesta con un modelo fijado, no con el que tenga puesto quien recibe", () => {
  // El aparte corre en tu maquina para contestar la pregunta de otro: que se lleve tu
  // modelo caro es una factura que no has decidido tu.
  const b = banderasAparte("v1", "/usr/local/bin/spoochie");
  expect(b[b.indexOf("--model") + 1]).toBe(MODELO_APARTE);
  expect(MODELO_APARTE).toBe("claude-sonnet-5");
});

test("el aparte sin nadie mirandolo lleva tope de gasto; la ventana no lo necesita", () => {
  // `--max-budget-usd` solo funciona con --print, o sea en modo fondo. En ventana el
  // freno es la persona que la mira, mas los dos relojes del spoochie.
  expect(presupuestoAparte()).toBe(PRESUPUESTO_APARTE);
  expect(banderasAparte("v1")).not.toContain("--max-budget-usd");
  const t: any = { id: "v1", subject: "s", from: { sessionId: "A", name: "a", cwd: "/a" }, to: { sessionId: "B", name: "b", cwd: "/b" }, context: {}, state: "open", messages: [] };
  expect(scriptVentana(t, "/tmp", "s1")).not.toContain("max-budget-usd");
});
