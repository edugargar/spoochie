import { expect, test, afterAll } from "bun:test";
import { releDePruebas } from "./rele.ts";

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
async function hasta(pred: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50; i++) { if (pred()) return true; await sleep(50); } return pred(); }

test("un sobre cruza un rele de verdad, cifrado, y llega solo a quien va dirigido", async () => {
  const N = await import("../src/nostr.ts");
  const ana = N.misClaves({} as any), bea = N.misClaves({} as any), otra = N.misClaves({} as any);
  const pool = N.poolReal();

  const paraBea: string[] = [], paraOtra: string[] = [];
  const subBea = pool.subscribe([rele.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: ev => { try { paraBea.push(N.abrir(ev, bea.sk)!.texto); } catch {} },
  });
  const subOtra = pool.subscribe([rele.url], { kinds: [1059], "#p": [otra.pk] }, {
    onevent: ev => { try { paraOtra.push(N.abrir(ev, otra.sk)!.texto); } catch {} },
  });
  await sleep(300);

  const { wrap } = N.envolver(ana.sk, bea.pk, { v: 1, id: "r1", kind: "msg" }, "el min-width del contenedor");
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
  const ana = N.misClaves({} as any), bea = N.misClaves({} as any);
  const pool = N.poolReal();

  // Publicado con nadie escuchando: es el caso de quien tiene el portatil cerrado.
  const { wrap } = N.envolver(ana.sk, bea.pk, { v: 1, id: "r2", kind: "invite", subject: "el modal" }, "mira esto");
  await Promise.all(pool.publish([rele.url], wrap));
  await sleep(200);

  const llegados: string[] = [];
  const sub = pool.subscribe([rele.url], { kinds: [1059], "#p": [bea.pk] }, {
    onevent: ev => { const a = N.abrir(ev, bea.sk); if (a) llegados.push(a.texto); },
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
  const ana = N.misClaves({} as any), bea = N.misClaves({} as any);

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

  const pool = N.poolReal();
  const uno = N.envolver(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "antes" }, "antes");
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

  const dos = N.envolver(ana.sk, bea.pk, { v: 1, id: "hola", kind: "hola", fromName: "despues" }, "despues");
  await Promise.all(N.poolReal().publish([rele.url], dos.wrap).map(p => p.catch(() => {})));
  expect(await hasta(() => holas.includes("despues"), 15000)).toBe(true);
  puente.cerrar();
}, 60000);

test("una suscripcion de SimplePool a pelo no revive sola: por eso el puente la revive", async () => {
  const N = await import("../src/nostr.ts");
  const bea = N.misClaves({} as any);
  const propio = releDePruebas();
  const pool = N.poolReal();
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
}, 30000);
