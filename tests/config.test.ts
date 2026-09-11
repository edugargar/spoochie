import { expect, test } from "bun:test";
import { plazo } from "./espera.ts";

test("un nombre de contacto ya ocupado por otro id no se pisa: va con sufijo", async () => {
  const Cfg = await import("../src/config.ts");
  const c: any = { guardian: false, transcript: false, contacts: {} };
  Cfg.addContact(c, { id: "U_EDU_REAL", name: "Edu", pk: "pk-real" });
  Cfg.addContact(c, { id: "U_IMPOSTOR", name: "Edu", pk: "pk-otro" });
  expect(Cfg.contact(c, "edu")!.id).toBe("U_EDU_REAL");
  expect(Cfg.contact(c, "edu")!.pk).toBe("pk-real");
  expect(Cfg.contactById(c, "U_IMPOSTOR")!.name).toBe("Edu");
  expect(Object.keys(c.contacts)).toContain("edu-stor");
  // El mismo id con otro nombre si se renombra, sin duplicar.
  Cfg.addContact(c, { id: "U_EDU_REAL", name: "Eduardo" });
  expect(Cfg.contact(c, "eduardo")!.pk).toBe("pk-real");
  expect(Cfg.contact(c, "edu")).toBeNull();
});

/**
 * Lo peor que hay aqui no necesita un atacante: basta morir a mitad de escribir.
 *
 * `save` truncaba y escribia, asi que un SIGKILL, un apagon o el OOM dejaban el fichero
 * por la mitad. Sonda: con el fichero cortado a la mitad, `load` devolvia la config por
 * defecto sin decir nada (clave de firma: no, agenda: vacia) y el siguiente `save` lo
 * escribia encima. Se perdian la clave de firma, la clave Nostr, el token del bot y
 * todos los contactos, en silencio y sin vuelta atras.
 */
test("una config a medias no se lleva por delante tus claves ni tu agenda", async () => {
  const Cfg = await import("../src/config.ts");
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ROOT } = await import("../src/paths.ts");
  const F = join(ROOT, "config.json");

  const c = Cfg.load();
  c.human = "Edu";
  c.keys = { pub: "PUB", priv: "PRIV-DE-FIRMA" } as any;
  Cfg.addContact(c, { id: "U_ATOM", name: "Sam", pk: "PK-DE-SAM" } as any);
  Cfg.save(c);
  Cfg.save(Cfg.load());            // una segunda para que exista la copia

  // Lo que deja un proceso muerto a mitad de escribir.
  const entero = readFileSync(F, "utf8");
  writeFileSync(F, entero.slice(0, Math.floor(entero.length / 2)));

  const d = Cfg.load();
  expect(d.human).toBe("Edu");
  expect(d.keys?.priv).toBe("PRIV-DE-FIRMA");
  expect(Cfg.contactById(d, "U_ATOM")?.name).toBe("Sam");
  expect(Cfg.configIlegible()).toBe(false);

  // Y si tampoco hay copia, se dice y NO se escribe encima: cambiar "no se leerla" por
  // "no existe" es perder las tres claves para siempre.
  writeFileSync(`${F}.bak`, "{ esto tampoco");
  const e = Cfg.load();
  expect(Cfg.configIlegible()).toBe(true);
  const antes = readFileSync(F, "utf8");
  Cfg.save(e);
  expect(readFileSync(F, "utf8")).toBe(antes);
  expect(existsSync(`${F}.nuevo`)).toBe(false);

  // Se deja como estaba para los demas tests del fichero.
  writeFileSync(F, entero);
  Cfg.olvidarRota();
  expect(Cfg.load().human).toBe("Edu");
});

/**
 * Dos procesos guardando la config a la vez.
 *
 * El demonio apunta un contacto en cada mensaje que entra (`tocarContacto`) y fija
 * claves; la CLI escribe en `join`, `contacts`, `confiar`, `rotar` y `olvidar`. Los dos
 * hacen leer-cambiar-guardar sobre el fichero entero, asi que el ultimo en guardar
 * borraba lo del otro. Medido con dos procesos de verdad: antes quedaba uno solo de los
 * dos contactos, o sea que una clave recien fijada (o las tuyas, recien creadas por
 * `join`) desaparecian sin decir nada.
 *
 * Tienen que ser dos procesos: dentro de uno, los dos `load` comparten el mismo estado y
 * la carrera no existe.
 */
test("dos procesos guardando a la vez no se borran el contacto del otro", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const casa = mkdtempSync(join(tmpdir(), "sp-carrera-"));
  const raiz = join(import.meta.dir, "..");
  const guion = join(casa, "uno.ts");
  writeFileSync(guion, `
const Cfg = await import(${JSON.stringify(join(raiz, "src", "config.ts"))});
const c = Cfg.load();
await new Promise(r => setTimeout(r, Number(process.env.ESPERA)));
Cfg.addContact(c, { id: process.env.ID, name: process.env.NOMBRE, pk: "PK-" + process.env.NOMBRE });
Cfg.save(c);
`);
  const env = { ...process.env, SPOOCHIE_HOME: casa };
  Bun.spawnSync(["bun", "-e", `const C = await import(${JSON.stringify(join(raiz, "src", "config.ts"))}); const c = C.load(); c.human = "Edu"; C.save(c);`], { env, cwd: raiz });

  // A lee, B lee, B guarda, A guarda encima: el caso que perdia a B.
  const a = Bun.spawn(["bun", "run", guion], { env: { ...env, ID: "U_CA", NOMBRE: "Ana", ESPERA: "400" }, cwd: raiz });
  const b = Bun.spawn(["bun", "run", guion], { env: { ...env, ID: "U_CB", NOMBRE: "Bea", ESPERA: "200" }, cwd: raiz });
  await Promise.all([a.exited, b.exited]);

  const fin = JSON.parse(readFileSync(join(casa, "config.json"), "utf8"));
  expect(Object.keys(fin.contacts ?? {}).sort()).toEqual(["ana", "bea"]);
  // Y ninguna de las dos claves se ha quedado por el camino.
  expect(fin.contacts.ana.pk).toBe("PK-Ana");
  expect(fin.contacts.bea.pk).toBe("PK-Bea");
}, plazo(20_000));

/**
 * Lo que se conserva es lo que apareció mientras teniamos nuestra copia en la mano, no
 * todo lo que haya en disco: si no, `spoochie olvidar` no olvidaria nunca.
 */
test("olvidar sigue olvidando aunque otro proceso haya escrito en medio", async () => {
  const Cfg = await import("../src/config.ts");
  const c = Cfg.load();
  Cfg.addContact(c, { id: "U_OLV", name: "Olvidable", pk: "PK" } as any);
  Cfg.save(c);

  const d = Cfg.load();
  delete d.contacts!["olvidable"];
  Cfg.save(d);
  expect(Cfg.contactById(Cfg.load(), "U_OLV")).toBeNull();
});
