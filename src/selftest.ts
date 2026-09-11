/**
 * Comprueba el bucle entero en esta maquina, sin necesitar a otra persona.
 *
 * Existe para el dia de la instalacion: alguien acaba de poner spoochie y quiere saber
 * si funciona antes de escribirle a un companero. Levanta dos buzones falsos, abre un
 * spoochie de uno a otro y recorre las mismas paradas que un spoochie de verdad: la
 * puerta de aprobacion, la ida y vuelta, el cierre y el aviso al otro lado.
 *
 * NO toca Slack ni tu estado real: corre en su propio SPOOCHIE_HOME temporal.
 */
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export type Paso = { ok: boolean; que: string; detalle: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

function buzon(nombre: string) {
  const sock = join(mkdtempSync(join(tmpdir(), `spoochie-st-${nombre}-`)), "s.sock");
  const recibido: string[] = [];
  const server = net.createServer(c => {
    let buf = "";
    c.on("data", d => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const linea = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const f = JSON.parse(linea); if (f.type === "user") recibido.push(f.message.content); } catch {}
      }
    });
    c.on("error", () => {});
  });
  server.listen(sock);
  return { sock, recibido, server };
}

export async function selftest(): Promise<Paso[]> {
  const pasos: Paso[] = [];
  const home = mkdtempSync(join(tmpdir(), "spoochie-selftest-"));
  const A = buzon("a"), B = buzon("b");
  let demonio: ReturnType<typeof spawn> | null = null;

  const rpc = (req: any): Promise<any> => new Promise((res, rej) => {
    const c = net.createConnection({ path: join(home, "daemon.sock") });
    let buf = "";
    c.setTimeout(10_000, () => { c.destroy(); rej(new Error("el demonio no contesta")); });
    c.on("error", rej);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { c.destroy(); res(JSON.parse(buf.slice(0, i))); } });
  });

  // Un paso que depende de otro roto no se ejecuta: daria "ok" por el motivo
  // equivocado, que es peor que un fallo porque te hace creer que algo funciona.
  const saltar = (que: string) => { pasos.push({ ok: false, que, detalle: "no se ha llegado a probar" }); };

  try {
    const entorno = { ...process.env, SPOOCHIE_HOME: home };
    // El registro se escribe a mano: paths.ts fija su raiz al cargarse, asi que
    // cambiar la variable de entorno a mitad de proceso no la mueve.
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    for (const [id, b, cwd] of [["st-a", A, "/tmp/st-a"], ["st-b", B, "/tmp/st-b"]] as const) {
      writeFileSync(
        join(home, "sessions", `${id}.json`),
        JSON.stringify({ sessionId: id, name: id, cwd, socket: b.sock, token: "t", pid: process.pid, startedAt: Date.now() }),
        { mode: 0o600 },
      );
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ guardian: false, transcript: false, aparte: false, human: "prueba" }), { mode: 0o600 });

    const { comandoDemonio } = await import("./arranque.ts");
    const [cmd, ...args] = comandoDemonio();
    demonio = spawn(cmd, args, { env: entorno, stdio: "ignore" });
    // Sin este oyente, un bun que no arranca tumba el proceso con un error sin recoger
    // en vez de contarte que el demonio no arranco, que es justo lo que vienes a saber.
    demonio.on("error", () => {});
    for (let i = 0; i < 60 && !existsSync(join(home, "daemon.sock")); i++) await dormir(100);
    const pong = await rpc({ op: "ping" });
    pasos.push({ ok: pong.ok === true, que: "el demonio arranca y contesta", detalle: `pid ${pong.pid}` });

    const abierto = await rpc({ op: "open", sessionId: "st-a", to: "st-b", subject: "prueba de instalacion", body: "si lees esto, el buzon funciona" });
    pasos.push({ ok: abierto.ok && abierto.delivered === true, que: "la invitacion llega al otro buzon", detalle: abierto.ok ? `spoochie ${abierto.id}` : abierto.error });
    if (!abierto.ok) {
      for (const q of ["el sobre dice como aceptar", "la puerta: no se contesta sin aceptar", "solo acepta quien recibe",
                       "el humano receptor abre el tunel", "ida y vuelta", "no se mandan mensajes vacios",
                       "al cerrar se avisa al otro lado"]) saltar(q);
      return pasos;
    }
    const id = abierto.id;

    pasos.push({
      ok: B.recibido.some(x => x.includes(`spoochie accept ${id}`)),
      que: "el sobre dice como aceptar",
      detalle: B.recibido.length ? "la invitacion trae el comando" : "no llego nada",
    });

    const pronto = await rpc({ op: "say", sessionId: "st-b", id, text: "contesto sin permiso" });
    pasos.push({ ok: pronto.ok === false, que: "la puerta: no se contesta sin aceptar", detalle: pronto.ok ? "SE COLO" : "rechazado, como debe" });

    const mal = await rpc({ op: "accept", sessionId: "st-a", id });
    pasos.push({ ok: mal.ok === false, que: "solo acepta quien recibe", detalle: mal.ok ? "acepto quien no debia" : "rechazado" });

    const bien = await rpc({ op: "accept", sessionId: "st-b", id });
    pasos.push({ ok: bien.ok === true, que: "el humano receptor abre el tunel", detalle: `estado ${bien.state}` });

    const ida = await rpc({ op: "say", sessionId: "st-b", id, text: "aqui esta mi respuesta" });
    pasos.push({ ok: ida.delivered === true && A.recibido.some(x => x.includes("aqui esta mi respuesta")), que: "ida y vuelta", detalle: "el mensaje llega entero al otro lado" });

    const vacio = await rpc({ op: "say", sessionId: "st-a", id, text: "  " });
    pasos.push({ ok: vacio.ok === false, que: "no se mandan mensajes vacios", detalle: vacio.ok ? "salio uno vacio" : "rechazado" });

    await rpc({ op: "close", sessionId: "st-a", id, reason: "fin de la prueba" });
    pasos.push({
      ok: B.recibido.some(x => x.includes(id) && x.includes("cerrado")),
      que: "al cerrar se avisa al otro lado",
      detalle: "el aviso de cierre llega",
    });

    // "Al cerrar se borra" es una de las tres promesas del README, y era la unica parada
    // del bucle que esta prueba no miraba: cerraba y se fiaba. En una maquina de verdad
    // `doctor` saco FALLO con doce spoochies cerrados que aun guardaban el texto.
    const ruta = join(home, "threads", `${id}.json`);
    let queda = -1;
    try {
      const t = JSON.parse(readFileSync(ruta, "utf8"));
      queda = (t.messages ?? []).filter((m: { text?: string }) => (m.text ?? "").length > 0).length;
    } catch { queda = 0; }
    pasos.push({
      ok: queda === 0,
      que: "al cerrar se borra lo que se dijo",
      detalle: queda === 0 ? "no queda texto en disco" : `QUEDAN ${queda} mensaje(s) con texto en ${ruta}`,
    });
  } catch (e) {
    pasos.push({ ok: false, que: "la prueba se rompio", detalle: String(e) });
  } finally {
    demonio?.kill();
    A.server.close(); B.server.close();
  }
  return pasos;
}
