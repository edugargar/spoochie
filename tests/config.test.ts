import { expect, test } from "bun:test";

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
