import { expect, test } from "bun:test";
import { leer } from "../src/auditoria.ts";
import { readFileSync } from "node:fs";

test("cada linea del registro es cuando, que, cual, quien y un detalle corto", () => {
  const bruto = [
    "2026-09-10T10:00:00.000Z\tabierto\tk7f\tEdu\t-> Sam · el modal",
    "2026-09-10T10:01:00.000Z\tretenido\tk7f\tSam\tpide ejecutar un script",
    "2026-09-10T10:02:00.000Z\tsoltado\tk7f\tEdu\t1 mensaje(s) · desde Slack",
  ].join("\n") + "\n";
  const l = leer(50, bruto);
  expect(l).toHaveLength(3);
  expect(l[0]).toEqual({ cuando: "2026-09-10T10:00:00.000Z", hecho: "abierto", id: "k7f", quien: "Edu", detalle: "-> Sam · el modal" });
  expect(l[1].hecho).toBe("retenido");
  expect(l[2].quien).toBe("Edu");
  // Se lee la cola, que es lo que interesa cuando el fichero lleva meses.
  expect(leer(1, bruto)[0].hecho).toBe("soltado");
  expect(leer(50, "")).toEqual([]);
});

test("el registro no guarda el texto de los mensajes: el borrado al cerrar sigue siendo verdad", () => {
  const fuente = readFileSync(new URL("../src/auditoria.ts", import.meta.url), "utf8");
  // Lo que se apunta es hecho, id, quien y detalle. Ningun sitio recibe m.text.
  expect(fuente).toContain("nunca el texto de los mensajes");
  const daemon = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  for (const linea of daemon.split("\n").filter(l => l.includes("Aud.apuntar("))) {
    expect(linea).not.toContain("m.text");
    expect(linea).not.toContain(".messages[");
  }
  // Y hay al menos un apunte por cada decision de una persona.
  for (const hecho of ["abierto", "aceptado", "rechazado", "retenido", "cerrado"]) {
    expect(daemon).toContain(`Aud.apuntar("${hecho}"`);
  }
  // Soltar y descartar salen del mismo sitio, segun lo que escribio la persona.
  expect(daemon).toContain('Aud.apuntar(orden === "suelta" ? "soltado" : "descartado"');
});
