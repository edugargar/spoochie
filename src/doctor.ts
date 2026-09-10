/**
 * Un repaso de todo lo que tiene que estar bien para que un spoochie llegue.
 *
 * Existe porque los fallos de esta herramienta son silenciosos por naturaleza: un token
 * caducado, un fichero con permisos flojos o un demonio muerto no dan error, solo hacen
 * que el mensaje no llegue y que nadie se entere.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SESSIONS_DIR, THREADS_DIR, DAEMON_SOCK, DAEMON_LOCK, OUTBOX_FILE } from "./paths.ts";
import { liveSessions, permisosFlojos } from "./registry.ts";
import * as Cfg from "./config.ts";
import * as T from "./threads.ts";
import { whoIs } from "./slack.ts";

export type Chequeo = { ok: boolean | "aviso"; que: string; detalle: string };

const modo = (p: string) => { try { return (statSync(p).mode & 0o777).toString(8).padStart(3, "0"); } catch { return "?"; } };

export async function revisar(): Promise<Chequeo[]> {
  const out: Chequeo[] = [];
  const c = Cfg.load();

  out.push({
    ok: existsSync(DAEMON_SOCK) && existsSync(DAEMON_LOCK),
    que: "demonio",
    detalle: existsSync(DAEMON_LOCK) ? `vivo, pid ${(await Bun.file(DAEMON_LOCK).text()).trim()}` : "no esta corriendo",
  });
  {
    const { edadLatido, launchdInstalado } = await import("./arranque.ts");
    const edad = edadLatido();
    out.push({
      ok: edad !== null && edad < 90,
      que: "latido del demonio",
      detalle: edad === null ? "nunca ha latido" : edad < 90 ? `hace ${Math.round(edad)} s${launchdInstalado() ? ", bajo launchd" : ", arrancado por un hook (muere con el reinicio)"}` : `hace ${Math.round(edad)} s: esta colgado o muerto`,
    });
  }

  const dirModo = modo(ROOT);
  out.push({
    ok: dirModo === "700",
    que: "permisos del directorio",
    detalle: `${ROOT} esta en ${dirModo}${dirModo === "700" ? "" : ", deberia ser 700"}`,
  });

  const flojos = existsSync(SESSIONS_DIR)
    ? readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json") && permisosFlojos(join(SESSIONS_DIR, f)))
    : [];
  out.push({
    ok: flojos.length === 0,
    que: "tokens de buzon en reposo",
    detalle: flojos.length
      ? `${flojos.length} con permisos abiertos: ${flojos.join(", ")}. chmod 600.`
      : "cada sesion registrada guarda su token con 0600, solo para ti",
  });

  const vivas = liveSessions();
  out.push({ ok: vivas.length > 0, que: "sesiones registradas", detalle: vivas.length ? vivas.map(s => s.name).join(", ") : "ninguna: falta el hook SessionStart, o reiniciar la sesion" });

  const socketsRotos = vivas.filter(s => !existsSync(s.socket));
  if (socketsRotos.length) out.push({ ok: false, que: "buzones", detalle: `${socketsRotos.length} sesiones sin socket` });

  if (!c.slack) {
    out.push({ ok: "aviso", que: "Slack", detalle: "sin configurar: spoochie solo funciona en esta maquina" });
  } else {
    const user = Cfg.slackToken(c), bot = Cfg.slackBotToken(c);
    const yo = user ? await whoIs(user) : null;
    const elBot = bot ? await whoIs(bot) : null;
    // El de usuario es opcional desde que el bot puede buscar personas: solo se
    // queja si esta puesto y no vale, no por faltar.
    if (user) out.push({ ok: Boolean(yo), que: "token de usuario", detalle: yo ? `${yo.user} en ${yo.team}` : "esta puesto y no vale" });
    out.push({ ok: Boolean(elBot), que: "token de bot", detalle: elBot ? `${elBot.user}` : "no vale o falta" });
    if (elBot && !user) {
      // Sin token de usuario, buscar personas depende de que la app tenga users:read
      // de bot. Si no lo tiene, abrir un spoochie por nombre o email falla en el unico
      // sitio donde duele: al escribirle a alguien por primera vez.
      const r = await fetch("https://slack.com/api/users.list?limit=1", { headers: { authorization: `Bearer ${bot}` } }).then(x => x.json()).catch(() => ({ ok: false }));
      out.push({
        ok: r.ok === true, que: "buscar personas",
        detalle: r.ok ? "el bot puede, no hace falta token de usuario"
                      : "la app necesita users:read y users:read.email como scopes de BOT",
      });
    }
    if (c.slack.tokenFile) {
      out.push({
        ok: !permisosFlojos(c.slack.tokenFile),
        que: "fichero de tokens",
        detalle: `${c.slack.tokenFile} en ${modo(c.slack.tokenFile)}`,
      });
    }
  }

  const abiertos = T.all().filter(t => t.state !== "closed");
  out.push({
    ok: true,
    que: "spoochies",
    detalle: `${abiertos.length} vivos, ${T.all().length} en total en esta maquina`,
  });

  out.push({
    ok: c.guardian ? "aviso" : true,
    que: "vigilante de tema",
    detalle: c.guardian
      ? "encendido: cuesta una llamada a Haiku por mensaje recibido, la paga quien recibe"
      : "apagado",
  });

  out.push({
    ok: true,
    que: "transcript",
    detalle: c.transcript ? "encendido: se pide republicar en cada turno a quien abrio" : "apagado",
  });

  {
    const N = await import("./nostr.ts");
    out.push({
      ok: c.nostr?.pk ? true : "aviso",
      que: "Nostr",
      detalle: c.nostr?.pk ? `${N.npub(c.nostr.pk).slice(0, 16)}..., reles: ${N.misReles(c).join(", ")}${c.transporte === "slack" ? " (los hilos van por Slack)" : ""}` : "sin clave todavia: nace con `spoochie nostr`, `invite` o `join`",
    });
    const sinClave = Object.values(c.contacts ?? {}).filter(k => !k.npub).map(k => k.name);
    if (sinClave.length) out.push({ ok: "aviso", que: "contactos sin clave Nostr", detalle: `${sinClave.join(", ")}: con ellos va por Slack hasta que su spoochie (>= 0.9) mande su clave` });
  }

  out.push({
    ok: true,
    que: "borrado al cerrar",
    detalle: c.borrarAlCerrar === false ? "apagado: las conversaciones se quedan en disco y en Slack" : "encendido: al cerrar se borra en local y lo que posteo el bot en Slack",
  });

  out.push({
    ok: true,
    que: "Claude aparte",
    detalle: c.aparte === false ? "apagado: todo entra en tu sesion" : `encendido${c.aparteCopia === false ? ", en el checkout real" : ", sobre una copia limpia del repo"}`,
  });

  {
    const { VERSION } = await import("./version.ts");
    const { avisoNueva } = await import("./actualizacion.ts");
    const nueva = await avisoNueva();
    out.push({ ok: nueva ? "aviso" : true, que: "version", detalle: nueva ? `${VERSION}; ${nueva}` : `${VERSION}, la ultima publicada` });
    const { versionLatido, edadLatido } = await import("./arranque.ts");
    const late = versionLatido();
    const vivo = (edadLatido() ?? Infinity) < 90;
    if (vivo && late !== VERSION) out.push({
      ok: "aviso",
      que: "version del demonio",
      detalle: `${late ?? "anterior a 0.9.1"}, y este spoochie es ${VERSION}: el demonio arranco antes de actualizar. Reinicia Claude Code y el hook lo cambia`,
    });
  }

  if (existsSync(OUTBOX_FILE)) {
    try {
      const n = (JSON.parse(readFileSync(OUTBOX_FILE, "utf8")) as { msgs: unknown[] }[]).reduce((a, d) => a + d.msgs.length, 0);
      if (n) out.push({ ok: "aviso", que: "cola de salida", detalle: `${n} mensaje(s) esperando salir a Slack; el demonio lo reintenta cada minuto` });
    } catch {}
  }

  if (existsSync(THREADS_DIR)) {
    const viejos = T.all().filter(t => t.state === "closed" && Date.now() - (t.closedAt ?? 0) > 30 * 24 * 3600 * 1000);
    if (viejos.length) out.push({ ok: "aviso", que: "limpieza", detalle: `${viejos.length} spoochies cerrados hace mas de un mes` });
  }

  // La parte de auditoria: no "esto esta roto", sino "esto es una credencial o un resto
  // que no deberia seguir aqui". Los fallos de seguridad tampoco dan error.
  out.push(...auditar(c));

  return out;
}

/**
 * Lo que no deberia seguir en disco. Cada punto es un agujero que hubo o que puede
 * abrirse solo con el paso del tiempo, y ninguno da error por su cuenta.
 */
export function auditar(c: Cfg.Config, ahora = Date.now()): Chequeo[] {
  const out: Chequeo[] = [];

  // Invitaciones sin canjear: cada una es un nonce que todavia deja entrar una clave.
  const pendientes = Object.values(c.invitaciones ?? {});
  if (pendientes.length) {
    const nombres = pendientes.map(i => i.name ?? i.id ?? "sin nombre").join(", ");
    out.push({
      ok: "aviso",
      que: "invitaciones sin canjear",
      detalle: `${pendientes.length} viva(s) (${nombres}): cada una deja entrar una clave en tu agenda hasta que caduque a los 30 dias`,
    });
  }

  // Contactos sin clave ed25519: sus sobres no se pueden comprobar, asi que entran
  // marcados y cualquiera con el token del bot podria ser el primero en firmar por ellos.
  const sinClave = Object.values(c.contacts ?? {}).filter(x => !x.pk);
  if (sinClave.length) {
    out.push({
      ok: "aviso",
      que: "contactos sin clave fijada",
      detalle: `${sinClave.map(x => x.name).join(", ")}: hasta que llegue un sobre suyo firmado, su primera firma es la que se fija`,
    });
  }

  // Un spoochie cerrado con texto todavia en disco: el borrado al cerrar no cumplio.
  const conTexto = T.all().filter(t => t.state === "closed" && t.messages.some(m => (m.text ?? "").trim()));
  out.push({
    ok: conTexto.length === 0,
    que: "borrado al cerrar",
    detalle: conTexto.length
      ? `${conTexto.length} spoochie(s) cerrados que todavia guardan el texto: ${conTexto.map(t => t.id).join(", ")}`
      : "ningun spoochie cerrado guarda texto",
  });

  // El token del bot en la config es el borde real del modelo de seguridad. No es un
  // fallo, pero quien lo tiene tiene el DM del bot con todo el equipo, y hay que
  // rotarlo cuando alguien se va.
  if (c.slack?.botToken) {
    out.push({
      ok: "aviso",
      que: "token de bot en reposo",
      detalle: `esta maquina guarda el token del bot del equipo en config.json: quien lo lea puede leer el DM del bot con cualquiera y postear como el. Rotalo cuando alguien se vaya`,
    });
  }

  return out;
}
