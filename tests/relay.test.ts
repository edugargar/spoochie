import { expect, test, afterAll } from "bun:test";
import { testRelay } from "./relay.ts";
import { hasta, plazo } from "./wait.ts";

/**
 * The real transport, against a real relay.
 *
 * Until now every test went through `filePool` (a shared directory), so `realPool`
 * (SimplePool over WebSocket), the only thing that runs outside the tests, had not a
 * single line of coverage: not the subscription, not the EOSE, not that the filters
 * spoochie sends are ones a relay understands.
 */
const relay = testRelay();
afterAll(() => relay.close());
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("an envelope crosses a real relay, encrypted, and reaches only its recipient", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any), other = N.myKeys({} as any);
  const pool = N.realPool();

  const forBea: string[] = [], forOther: string[] = [];
  const subBea = pool.subscribe([relay.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: ev => { try { forBea.push(N.open(ev, bea.sk)!.texto); } catch {} },
  });
  const subOther = pool.subscribe([relay.url], { kinds: [1059], "#p": [other.pk] }, {
    onevent: ev => { try { forOther.push(N.open(ev, other.sk)!.texto); } catch {} },
  });
  await sleep(300);

  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "r1", kind: "msg" }, "the container's min-width");
  await Promise.all(pool.publish([relay.url], wrap));

  expect(await hasta(() => forBea.length > 0)).toBe(true);
  expect(forBea[0]).toBe("the container's min-width");
  // The relay stores it, but to the relay it is noise: the text is not in the event.
  expect(relay.events()).toBe(1);
  expect(JSON.stringify(wrap)).not.toContain("min-width");
  // And it does not reach anyone it is not addressed to, because the filter is on the p tag.
  expect(forOther).toHaveLength(0);

  subBea.close(); subOther.close();
});

test("what was published with nobody listening arrives on subscribing later", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const pool = N.realPool();

  // Published with nobody listening: the case of someone with their laptop closed.
  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "r2", kind: "invite", subject: "the modal" }, "look at this");
  await Promise.all(pool.publish([relay.url], wrap));
  await sleep(200);

  const arrived: string[] = [];
  const sub = pool.subscribe([relay.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: ev => { const a = N.open(ev, bea.sk); if (a) arrived.push(a.texto); },
  });
  expect(await hasta(() => arrived.includes("look at this"))).toBe(true);
  sub.close();
});

test("the relay answers a REQ with EOSE, which is what any Nostr client expects", async () => {
  // spoochie's Pool interface does not expose EOSE, so it is checked by hand: without
  // EOSE, a client waits forever for the initial load.
  const ws = new WebSocket(relay.url);
  const received: unknown[][] = [];
  await new Promise<void>(r => { ws.onopen = () => r(); });
  ws.onmessage = e => received.push(JSON.parse(String(e.data)));
  ws.send(JSON.stringify(["REQ", "sub-eose", { kinds: [1059], "#p": ["a".repeat(64)] }]));
  expect(await hasta(() => received.some(m => m[0] === "EOSE" && m[1] === "sub-eose"))).toBe(true);
  ws.close();
});

test("if the relay drops and comes back, the bridge resubscribes on its own and what follows arrives", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);

  // At the SimplePool level, a dead subscription does NOT come back: checked below. What
  // brings it back is NostrBridge, with its onclose and a retry after 5 s. That had no
  // test, and it is the only thing between "a relay dropped for a moment" and "this
  // daemon stopped receiving and nobody noticed".
  const hellos: string[] = [];
  const bridge = new N.NostrBridge(bea.sk, bea.pk, [relay.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _env, name) => { hellos.push(name); },
    log: () => {},
  });
  bridge.escuchar();
  await sleep(400);

  const pool = N.realPool();
  const one = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "before" }, "before");
  await Promise.all(pool.publish([relay.url], one.wrap));
  expect(await hasta(() => hellos.includes("before"))).toBe(true);

  // The relay drops with the subscription open. Whatever is published meanwhile is lost,
  // and that is fine; what must not happen is that it never recovers.
  const reqsBefore = relay.reqs();
  relay.takeDown();
  await sleep(500);
  relay.bringUp();
  // The bridge retries after 5 s.
  expect(await hasta(() => relay.reqs() > reqsBefore, 20000)).toBe(true);

  const two = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "after" }, "after");
  await Promise.all(N.realPool().publish([relay.url], two.wrap).map(p => p.catch(() => {})));
  expect(await hasta(() => hellos.includes("after"), 15000)).toBe(true);
  bridge.cerrar();
}, plazo(60000));

test("a bare SimplePool subscription does not come back on its own: that is why the bridge revives it", async () => {
  const N = await import("../src/nostr.ts");
  const bea = N.myKeys({} as any);
  const own = testRelay();
  const pool = N.realPool();
  let closes = 0;
  const sub = pool.subscribe([own.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: () => {},
    onclose: () => { closes++; },
  });
  await sleep(400);
  expect(own.reqs()).toBe(1);
  own.takeDown();
  await sleep(500);
  own.bringUp();
  await sleep(8000);
  // Eight seconds later there is still no second subscription: nobody came back.
  expect(own.reqs()).toBe(1);
  expect(own.clients()).toBe(0);
  expect(closes).toBeGreaterThan(0);
  sub.close(); own.close();
}, plazo(30000));

test("the same envelope twice is delivered once: relays repeat and do not keep order", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const hellos: string[] = [];
  const bridge = new N.NostrBridge(bea.sk, bea.pk, [relay.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, name) => { hellos.push(name); },
    log: () => {},
  });
  bridge.escuchar();
  await sleep(400);

  const pool = N.realPool();
  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "repeated" }, "repeated");
  // Published twice, which is what a relay that resends does, or two relays with the
  // same event: the wrap is the same, so the event id is the same.
  await Promise.all(pool.publish([relay.url], wrap));
  await sleep(300);
  await Promise.all(pool.publish([relay.url], wrap));
  await sleep(800);

  expect(relay.events()).toBeGreaterThanOrEqual(2);
  expect(hellos.filter(h => h === "repeated")).toHaveLength(1);
  bridge.cerrar();
}, plazo(20000));

test("two envelopes arriving in reverse order are both still delivered", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const hellos: string[] = [];
  const bridge = new N.NostrBridge(bea.sk, bea.pk, [relay.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, name) => { hellos.push(name); },
    log: () => {},
  });
  bridge.escuchar();
  await sleep(400);

  const pool = N.realPool();
  const first = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "first" }, "first");
  const second = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "second" }, "second");
  // In reverse of how they were written. Relays do not guarantee order, and the wrap also
  // carries a deliberately fake date, so sorting by created_at does not work.
  await Promise.all(pool.publish([relay.url], second.wrap));
  await Promise.all(pool.publish([relay.url], first.wrap));

  expect(await hasta(() => hellos.includes("first") && hellos.includes("second"))).toBe(true);
  bridge.cerrar();
}, plazo(20000));

/**
 * A relay that drops while the others stay alive.
 *
 * The test above takes down the ONLY relay, and then SimplePool does call onclose. With
 * several it does not: nostr-tools 2.25.2 only calls it once all of them have closed
 * (pool.js, `closesReceived.length === groupedRequests.length`). Measured on a real
 * machine on 14-09: the hello from someone who had just joined was only on nos.lol, and
 * the daemon, which had been listening to three relays for hours, got primal's and never
 * that one.
 */
test("if one of two relays drops and comes back, what is published only there still arrives", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const drops = testRelay(), stays = testRelay();
  const hellos: string[] = [];
  const bridge = new N.NostrBridge(bea.sk, bea.pk, [drops.url, stays.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, name) => { hellos.push(name); },
    log: () => {},
  });
  bridge.escuchar();
  await sleep(400);

  drops.takeDown();
  await sleep(500);
  drops.bringUp();
  await sleep(7000);

  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "only on the one that dropped" }, "x");
  await Promise.all(N.realPool().publish([drops.url], wrap).map(p => p.catch(() => {})));
  expect(await hasta(() => hellos.includes("only on the one that dropped"), 15000)).toBe(true);
  bridge.cerrar(); drops.close(); stays.close();
}, plazo(60000));

/**
 * The relay that stops sending without hanging up. The socket stays open, so there is no
 * onclose to rely on: the only defence is asking again every so often. Repeats cost
 * nothing, `seen` removes them.
 */
test("if a relay forgets the subscription without hanging up, the bridge asks again", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const mute = testRelay();
  const hellos: string[] = [];
  const bridge = new N.NostrBridge(bea.sk, bea.pk, [mute.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, name) => { hellos.push(name); },
    log: () => {},
  }, undefined, { refrescoMs: 1500 });
  bridge.escuchar();
  await sleep(400);
  mute.forgetSubs();

  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "after forgetting" }, "x");
  await Promise.all(N.realPool().publish([mute.url], wrap));
  expect(await hasta(() => hellos.includes("after forgetting"), 10000)).toBe(true);
  expect(hellos.filter(h => h === "after forgetting")).toHaveLength(1);
  bridge.cerrar(); mute.close();
}, plazo(30000));
