/**
 * Ficheros entre maquinas: capturas, sobre todo.
 *
 * Dentro de una maquina un fichero viaja como ruta absoluta y lo abre el Claude de
 * enfrente con sus propios permisos. Entre maquinas esa ruta no existe, asi que los
 * bytes van por Slack: los sube el bot al hilo y el demonio del otro lado se los baja
 * a su propio spool antes de dar la ruta a su sesion.
 *
 * NO se usa `file_attachments` del buzon de Claude Code: existe, pero es superficie
 * sin documentar, con spool e integridad propios. Aqui el fichero se ve ademas en el
 * hilo, que es donde miran las personas.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { basename, join, extname } from "node:path";
import { ROOT } from "./paths.ts";

const API = "https://slack.com/api/";
/** Un limite deliberado: spoochie es para pistas, no para mover binarios. */
export const MAX_BYTES = 10 * 1024 * 1024;
export const SPOOL = join(ROOT, "files");

const seguro = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "fichero";

export type Subido = { id: string; nombre: string };

/** Sube un fichero al hilo. Devuelve null si no cabe o si Slack dice que no. */
export async function subir(token: string, ruta: string, channel: string, threadTs: string): Promise<Subido | null> {
  let bytes: Buffer;
  try {
    if (statSync(ruta).size > MAX_BYTES) return null;
    bytes = readFileSync(ruta);
  } catch { return null; }
  const nombre = seguro(basename(ruta));

  const cab = { authorization: `Bearer ${token}` };
  const paso1 = await fetch(`${API}files.getUploadURLExternal?${new URLSearchParams({ filename: nombre, length: String(bytes.length) })}`, { headers: cab });
  const j1 = await paso1.json();
  if (!j1.ok) return null;

  const paso2 = await fetch(j1.upload_url, { method: "POST", body: new Blob([bytes as unknown as BlobPart]) });
  if (!paso2.ok) return null;

  const paso3 = await fetch(`${API}files.completeUploadExternal`, {
    method: "POST",
    headers: { ...cab, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ files: [{ id: j1.file_id, title: nombre }], channel_id: channel, thread_ts: threadTs }),
  });
  const j3 = await paso3.json();
  return j3.ok ? { id: j1.file_id, nombre } : null;
}

/**
 * De donde se aceptan bytes con el token del bot delante.
 *
 * `bajar` manda `Authorization: Bearer <token del bot>` a la URL que diga el campo
 * `url_private` del mensaje. Hoy ese campo lo pone la API de Slack por TLS, asi que no
 * hay agujero abierto; el problema es que la funcion depende de eso y no lo comprueba.
 * Una URL con otro anfitrion se lleva el token del equipo entero.
 */
const ANFITRIONES = /^https:\/\/([a-z0-9-]+\.)*slack(-files)?\.com\//i;

/** Baja los ficheros de un mensaje al spool y devuelve sus rutas locales. */
export async function bajar(token: string, ficheros: any[], threadId: string): Promise<string[]> {
  // El id llega validado por `ID_VALIDO` desde que se materializa el hilo, pero esta
  // funcion no lo sabe: aqui acaba en un `join`, y un id con `../` escribe fuera del
  // spool. Se limpia igual, que cuesta una linea y no depende de nadie.
  const dir = join(SPOOL, seguro(threadId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rutas: string[] = [];
  for (const f of ficheros ?? []) {
    const url = f?.url_private_download ?? f?.url_private;
    if (typeof url !== "string" || !ANFITRIONES.test(url)) continue;
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;
      // El nombre lo pone el emisor: se limpia antes de tocar el disco.
      const nombre = seguro(f.name ?? `${f.id}${extname(f.filetype ? `.${f.filetype}` : "")}`);
      // El id tambien lo pone el otro lado. Sin limpiarlo, un id con ../ escribe
      // fuera del spool, que es peor que un nombre feo.
      const destino = join(dir, `${seguro(String(f.id ?? "s"))}-${nombre}`);
      writeFileSync(destino, buf, { mode: 0o600 });
      rutas.push(destino);
    } catch {}
  }
  return rutas;
}
