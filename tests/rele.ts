/**
 * Un rele de Nostr de verdad, en el propio proceso de pruebas.
 *
 * Por que hace falta. Todos los tests iban por `poolDeFichero`, que escribe cada evento
 * como un JSON en un directorio y lo lee con un setInterval. Eso prueba el sobre, el
 * cifrado y el reparto, pero NO prueba `poolReal`, que es SimplePool sobre WebSocket y
 * es lo unico que corre en casa de la gente: ni la suscripcion, ni el EOSE, ni la
 * reconexion, ni que los filtros que manda spoochie sean los que un rele entiende.
 *
 * Esto habla lo justo de NIP-01 para que SimplePool funcione: EVENT, REQ con filtros
 * (kinds, #p, ids, authors, since, limit), EOSE, CLOSE y OK. Y se puede tirar a
 * proposito, que es lo que hace falta para probar que pasa cuando el rele se cae.
 *
 * No valida firmas ni proof of work: no es un rele para internet, es un rele para un
 * test que tiene que fallar por lo que se esta probando y no por otra cosa.
 */
import type { Server, ServerWebSocket } from "bun";

type Evento = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string; sig?: string };
type Filtro = { ids?: string[]; authors?: string[]; kinds?: number[]; since?: number; until?: number; limit?: number; [tag: string]: unknown };
type Cliente = { subs: Map<string, Filtro[]> };

function casa(ev: Evento, f: Filtro): boolean {
  if (f.ids?.length && !f.ids.includes(ev.id)) return false;
  if (f.authors?.length && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds?.length && !f.kinds.includes(ev.kind)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  if (typeof f.until === "number" && ev.created_at > f.until) return false;
  // Filtros por etiqueta: "#p", "#e"... El valor de la etiqueta es tags[n][1].
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith("#") || !Array.isArray(v) || !v.length) continue;
    const letra = k.slice(1);
    if (!ev.tags.some(t => t[0] === letra && v.includes(t[1]))) return false;
  }
  return true;
}

export type Rele = {
  url: string;
  /** Cuantos eventos ha aceptado, para poder afirmar que algo salio de verdad. */
  eventos: () => number;
  /** Cuantos REQ ha recibido y cuantos clientes tiene conectados ahora mismo. */
  reqs: () => number;
  clientes: () => number;
  /** Tira el rele. Las conexiones se cortan; SimplePool tendra que reconectar. */
  tirar: () => void;
  /** Lo levanta otra vez en el mismo puerto. */
  levantar: () => void;
  cerrar: () => void;
};

export function releDePruebas(puerto = 0): Rele {
  const guardados: Evento[] = [];
  let reqs = 0;
  const clientes = new Map<ServerWebSocket<Cliente>, Cliente>();
  let server: Server | null = null;
  let real = puerto;

  const arrancar = () => {
    server = Bun.serve<Cliente, {}>({
      port: real,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: { subs: new Map() } })) return;
        return new Response("rele de pruebas", { status: 200 });
      },
      websocket: {
        open(ws) { clientes.set(ws, ws.data); },
        close(ws) { clientes.delete(ws); },
        message(ws, raw) {
          let msg: unknown[];
          try { msg = JSON.parse(String(raw)); } catch { return; }
          const [tipo] = msg as [string];

          if (tipo === "EVENT") {
            const ev = msg[1] as Evento;
            guardados.push(ev);
            ws.send(JSON.stringify(["OK", ev.id, true, ""]));
            // A quien tenga una suscripcion viva que case.
            for (const [otro, c] of clientes) {
              for (const [sub, filtros] of c.subs) {
                if (filtros.some(f => casa(ev, f))) otro.send(JSON.stringify(["EVENT", sub, ev]));
              }
            }
            return;
          }

          if (tipo === "REQ") {
            const sub = msg[1] as string;
            const filtros = msg.slice(2) as Filtro[];
            reqs++;
            ws.data.subs.set(sub, filtros);
            // Lo que ya habia, en orden, y luego EOSE: sin EOSE, SimplePool se queda
            // esperando y nunca da por hecha la carga inicial.
            for (const ev of guardados) {
              if (filtros.some(f => casa(ev, f))) ws.send(JSON.stringify(["EVENT", sub, ev]));
            }
            ws.send(JSON.stringify(["EOSE", sub]));
            return;
          }

          if (tipo === "CLOSE") ws.data.subs.delete(msg[1] as string);
        },
      },
    });
    real = server.port;
  };

  arrancar();
  return {
    get url() { return `ws://127.0.0.1:${real}`; },
    eventos: () => guardados.length,
    reqs: () => reqs,
    clientes: () => clientes.size,
    tirar: () => { server?.stop(true); server = null; clientes.clear(); },
    levantar: () => { if (!server) arrancar(); },
    cerrar: () => { server?.stop(true); server = null; },
  };
}
