import { expect, test, afterAll } from "bun:test";
import { releDePruebas } from "./relay.ts";
import { hasta, plazo } from "./wait.ts";

/**
 * El transporte de verdad, contra un rele de verdad.
 *
 * Hasta ahora todos los tests iban por `poolDeFichero` (un directorio compartido), asi
 * que `poolReal` (SimplePool sobre WebSocket), que es lo unico que corre fuera de los
 * tests, no tenia ni una linea de cobertura: ni la suscripcion, ni el EOSE, ni que los
 * filtros que manda spoochie sean los que un rele entiende.
 */
const rele = releDePruebas();
afterAll(() => rele.cerrar());
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("un sobre cruza un rele de verdad, cifrado, y llega solo a quien va dirigido", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any), otra = N.myKeys({} as any);
  const pool = N.realPool();

  const paraBea: string[] = [], paraOtra: string[] = [];
  const subBea = pool.subscribe([rele.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: ev => { try { paraBea.push(N.open(ev, bea.sk)!.texto); } catch {} },
  });
  const subOtra = pool.subscribe([rele.url], { kinds: [1059], "#p": [otra.pk] }, {
    onevent: ev => { try { paraOtra.push(N.open(ev, otra.sk)!.texto); } catch {} },
  });
  await sleep(300);

  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "r1", kind: "msg" }, "el min-width del contenedor");
  await Promise.all(pool.publish([rele.url], wrap));

  expect(await hasta(() => paraBea.length > 0)).toBe(true);
  expect(paraBea[0]).toBe("el min-width del contenedor");
  // El rele lo guarda, pero para el es ruido: el texto no esta en el evento.
  expect(rele.eventos()).toBe(1);
  expect(JSON.stringify(wrap)).not.toContain("min-width");
  // Y a quien no va dirigido no le llega, porque el filtro es por la etiqueta p.
  expect(paraOtra).toHaveLength(0);

  subBea.close(); subOtra.close();
});

test("lo publicado con nadie escuchando llega al suscribirse despues", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const pool = N.realPool();

  // Publicado con nadie escuchando: es el caso de quien tiene el portatil cerrado.
  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "r2", kind: "invite", subject: "el modal" }, "mira esto");
  await Promise.all(pool.publish([rele.url], wrap));
  await sleep(200);

  const llegados: string[] = [];
  const sub = pool.subscribe([rele.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: ev => { const a = N.open(ev, bea.sk); if (a) llegados.push(a.texto); },
  });
  expect(await hasta(() => llegados.includes("mira esto"))).toBe(true);
  sub.close();
});

test("el rele contesta EOSE al REQ, que es lo que espera cualquier cliente de Nostr", async () => {
  // El interfaz Pool de spoochie no expone el EOSE, asi que se comprueba a pelo: sin
  // EOSE, un cliente se queda esperando para siempre la carga inicial.
  const ws = new WebSocket(rele.url);
  const recibidos: unknown[][] = [];
  await new Promise<void>(r => { ws.onopen = () => r(); });
  ws.onmessage = e => recibidos.push(JSON.parse(String(e.data)));
  ws.send(JSON.stringify(["REQ", "sub-eose", { kinds: [1059], "#p": ["a".repeat(64)] }]));
  expect(await hasta(() => recibidos.some(m => m[0] === "EOSE" && m[1] === "sub-eose"))).toBe(true);
  ws.close();
});

test("si el rele se cae y vuelve, el puente se resuscribe solo y lo de despues llega", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);

  // A nivel de SimplePool, una suscripcion muerta NO revive: se comprueba abajo. Quien
  // la revive es NostrBridge, con su onclose y un reintento a los 5 s. Eso es lo que
  // no tenia test, y es lo unico que separa "se cayo un rele un momento" de "este
  // demonio dejo de recibir y nadie se entera".
  const holas: string[] = [];
  const puente = new N.NostrBridge(bea.sk, bea.pk, [rele.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _sobre, nombre) => { holas.push(nombre); },
    log: () => {},
  });
  puente.escuchar();
  await sleep(400);

  const pool = N.realPool();
  const uno = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "antes" }, "antes");
  await Promise.all(pool.publish([rele.url], uno.wrap));
  expect(await hasta(() => holas.includes("antes"))).toBe(true);

  // El rele se cae con la suscripcion abierta. Lo que se publique mientras se pierde, y
  // esta bien que se pierda; lo que no puede pasar es que no se recupere.
  const reqsAntes = rele.reqs();
  rele.tirar();
  await sleep(500);
  rele.levantar();
  // El reintento del puente es a los 5 s.
  expect(await hasta(() => rele.reqs() > reqsAntes, 20000)).toBe(true);

  const dos = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "despues" }, "despues");
  await Promise.all(N.realPool().publish([rele.url], dos.wrap).map(p => p.catch(() => {})));
  expect(await hasta(() => holas.includes("despues"), 15000)).toBe(true);
  puente.cerrar();
}, plazo(60000));

test("una suscripcion de SimplePool a pelo no revive sola: por eso el puente la revive", async () => {
  const N = await import("../src/nostr.ts");
  const bea = N.myKeys({} as any);
  const propio = releDePruebas();
  const pool = N.realPool();
  let cerradas = 0;
  const sub = pool.subscribe([propio.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: () => {},
    onclose: () => { cerradas++; },
  });
  await sleep(400);
  expect(propio.reqs()).toBe(1);
  propio.tirar();
  await sleep(500);
  propio.levantar();
  await sleep(8000);
  // Ocho segundos despues sigue sin haber una segunda suscripcion: nadie ha vuelto.
  expect(propio.reqs()).toBe(1);
  expect(propio.clientes()).toBe(0);
  expect(cerradas).toBeGreaterThan(0);
  sub.close(); propio.cerrar();
}, plazo(30000));

test("el mismo sobre dos veces se entrega una: los reles repiten y no ordenan", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const holas: string[] = [];
  const puente = new N.NostrBridge(bea.sk, bea.pk, [rele.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, nombre) => { holas.push(nombre); },
    log: () => {},
  });
  puente.escuchar();
  await sleep(400);

  const pool = N.realPool();
  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "repetido" }, "repetido");
  // Publicado dos veces, que es lo que hace un rele que reenvia o dos reles con el mismo
  // evento: la envoltura es la misma, asi que el id del evento es el mismo.
  await Promise.all(pool.publish([rele.url], wrap));
  await sleep(300);
  await Promise.all(pool.publish([rele.url], wrap));
  await sleep(800);

  expect(rele.eventos()).toBeGreaterThanOrEqual(2);
  expect(holas.filter(h => h === "repetido")).toHaveLength(1);
  puente.cerrar();
}, plazo(20000));

test("dos sobres que llegan al reves siguen entregandose los dos", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const holas: string[] = [];
  const puente = new N.NostrBridge(bea.sk, bea.pk, [rele.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, nombre) => { holas.push(nombre); },
    log: () => {},
  });
  puente.escuchar();
  await sleep(400);

  const pool = N.realPool();
  const primero = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "primero" }, "primero");
  const segundo = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "segundo" }, "segundo");
  // Al reves de como se escribieron. Los reles no garantizan orden, y la envoltura lleva
  // ademas una fecha falseada a proposito, asi que ordenar por created_at no vale.
  await Promise.all(pool.publish([rele.url], segundo.wrap));
  await Promise.all(pool.publish([rele.url], primero.wrap));

  expect(await hasta(() => holas.includes("primero") && holas.includes("segundo"))).toBe(true);
  puente.cerrar();
}, plazo(20000));

/**
 * Un rele que se cae mientras los otros siguen vivos.
 *
 * El test de arriba tira el UNICO rele, y ahi SimplePool si llama a onclose. Con varios
 * no: nostr-tools 2.25.2 solo lo llama cuando han cerrado todos (pool.js,
 * `closesReceived.length === groupedRequests.length`). Medido en una maquina de verdad
 * el 14-09: el saludo de alguien recien dado de alta estaba solo en nos.lol, y el
 * demonio, que llevaba horas escuchando tres reles, recibio lo de primal y nunca eso.
 */
test("si se cae uno de dos reles y vuelve, lo que se publica solo en ese llega igual", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const cae = releDePruebas(), sigue = releDePruebas();
  const holas: string[] = [];
  const puente = new N.NostrBridge(bea.sk, bea.pk, [cae.url, sigue.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, nombre) => { holas.push(nombre); },
    log: () => {},
  });
  puente.escuchar();
  await sleep(400);

  cae.tirar();
  await sleep(500);
  cae.levantar();
  await sleep(7000);

  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "solo en el que cayo" }, "x");
  await Promise.all(N.realPool().publish([cae.url], wrap).map(p => p.catch(() => {})));
  expect(await hasta(() => holas.includes("solo en el que cayo"), 15000)).toBe(true);
  puente.cerrar(); cae.cerrar(); sigue.cerrar();
}, plazo(60000));

/**
 * El rele que deja de mandar sin cortar. El socket sigue abierto, asi que no hay
 * onclose que valga: la unica defensa es volver a pedir cada cierto tiempo. Los
 * repetidos no cuestan nada, `vistos` los quita.
 */
test("si un rele olvida la suscripcion sin cortar, el puente la vuelve a pedir", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.myKeys({} as any), bea = N.myKeys({} as any);
  const mudo = releDePruebas();
  const holas: string[] = [];
  const puente = new N.NostrBridge(bea.sk, bea.pk, [mudo.url], {
    onMessage: async () => {}, onRemoteAccept: async () => {}, onCierre: async () => {},
    onHola: async (_de, _s, nombre) => { holas.push(nombre); },
    log: () => {},
  }, undefined, { refrescoMs: 1500 });
  puente.escuchar();
  await sleep(400);
  mudo.olvidar();

  const { wrap } = N.wrapEnvelope(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "tras olvidar" }, "x");
  await Promise.all(N.realPool().publish([mudo.url], wrap));
  expect(await hasta(() => holas.includes("tras olvidar"), 10000)).toBe(true);
  expect(holas.filter(h => h === "tras olvidar")).toHaveLength(1);
  puente.cerrar(); mudo.cerrar();
}, plazo(30000));
