/**
 * A real Nostr relay, inside the test process itself.
 *
 * Why it is needed. Every test went through `filePool`, which writes each event as a JSON
 * file in a directory and reads it with a setInterval. That tests the envelope, the
 * encryption and the delivery, but NOT `realPool`, which is SimplePool over WebSocket and
 * the only thing that runs on people's machines: not the subscription, not the EOSE, not
 * the reconnection, not that the filters spoochie sends are ones a relay understands.
 *
 * This speaks just enough NIP-01 for SimplePool to work: EVENT, REQ with filters (kinds,
 * #p, ids, authors, since, limit), EOSE, CLOSE and OK. And it can be taken down on
 * purpose, which is what it takes to test what happens when the relay drops.
 *
 * It validates neither signatures nor proof of work: it is not a relay for the internet,
 * it is a relay for a test that has to fail because of what is being tested and nothing else.
 */
import type { Server, ServerWebSocket } from "bun";

type NostrEvent = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string; sig?: string };
type Filter = { ids?: string[]; authors?: string[]; kinds?: number[]; since?: number; until?: number; limit?: number; [tag: string]: unknown };
type Client = { subs: Map<string, Filter[]> };

function matches(ev: NostrEvent, f: Filter): boolean {
  if (f.ids?.length && !f.ids.includes(ev.id)) return false;
  if (f.authors?.length && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds?.length && !f.kinds.includes(ev.kind)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  if (typeof f.until === "number" && ev.created_at > f.until) return false;
  // Tag filters: "#p", "#e"... The tag's value is tags[n][1].
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith("#") || !Array.isArray(v) || !v.length) continue;
    const letter = k.slice(1);
    if (!ev.tags.some(t => t[0] === letter && v.includes(t[1]))) return false;
  }
  return true;
}

export type TestRelay = {
  url: string;
  /** How many events it has accepted, so a test can assert something really went out. */
  events: () => number;
  /** How many REQs it has received and how many clients are connected right now. */
  reqs: () => number;
  clients: () => number;
  /** Takes the relay down. Connections are cut; SimplePool will have to reconnect. */
  takeDown: () => void;
  /** Brings it back up on the same port. */
  bringUp: () => void;
  /** Forgets the subscriptions without cutting the socket: the relay that restarts its
   *  process behind a proxy, or the one that drops a REQ without saying CLOSED. */
  forgetSubs: () => void;
  close: () => void;
};

export function testRelay(port = 0): TestRelay {
  const stored: NostrEvent[] = [];
  let reqs = 0;
  const clients = new Map<ServerWebSocket<Client>, Client>();
  let server: Server | null = null;
  let actualPort = port;

  const start = () => {
    server = Bun.serve<Client, {}>({
      port: actualPort,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: { subs: new Map() } })) return;
        return new Response("test relay", { status: 200 });
      },
      websocket: {
        open(ws) { clients.set(ws, ws.data); },
        close(ws) { clients.delete(ws); },
        message(ws, raw) {
          let msg: unknown[];
          try { msg = JSON.parse(String(raw)); } catch { return; }
          const [type] = msg as [string];

          if (type === "EVENT") {
            const ev = msg[1] as NostrEvent;
            stored.push(ev);
            ws.send(JSON.stringify(["OK", ev.id, true, ""]));
            // To whoever has a live subscription that matches.
            for (const [other, c] of clients) {
              for (const [sub, filters] of c.subs) {
                if (filters.some(f => matches(ev, f))) other.send(JSON.stringify(["EVENT", sub, ev]));
              }
            }
            return;
          }

          if (type === "REQ") {
            const sub = msg[1] as string;
            const filters = msg.slice(2) as Filter[];
            reqs++;
            ws.data.subs.set(sub, filters);
            // What was already there, in order, and then EOSE: without EOSE, SimplePool
            // keeps waiting and never considers the initial load done.
            for (const ev of stored) {
              if (filters.some(f => matches(ev, f))) ws.send(JSON.stringify(["EVENT", sub, ev]));
            }
            ws.send(JSON.stringify(["EOSE", sub]));
            return;
          }

          if (type === "CLOSE") ws.data.subs.delete(msg[1] as string);
        },
      },
    });
    actualPort = server.port;
  };

  start();
  return {
    get url() { return `ws://127.0.0.1:${actualPort}`; },
    events: () => stored.length,
    reqs: () => reqs,
    clients: () => clients.size,
    takeDown: () => { server?.stop(true); server = null; clients.clear(); },
    bringUp: () => { if (!server) start(); },
    forgetSubs: () => { for (const c of clients.values()) c.subs.clear(); },
    close: () => { server?.stop(true); server = null; },
  };
}
