/**
 * La version del protocolo, y que hacer con un sobre que no se entiende.
 *
 * El sobre lleva `v` desde el primer dia y nadie lo miraba nunca: era un 1 escrito a
 * mano en diez sitios. Eso vale mientras solo exista un 1. En cuanto salga un 2, un
 * spoochie viejo recibiria un sobre con campos que no conoce y lo tratatia como si los
 * entendiera: entregaria el texto sin la parte que lo acota, o sin la que lo retiene.
 *
 * Con el binario distribuido por version de plugin, dos maquinas desparejadas es el caso
 * NORMAL durante semanas, asi que la regla tiene que estar escrita antes de que haga
 * falta, no despues.
 *
 * La regla:
 *   v igual o menor    se entiende, se entrega (la compatibilidad hacia atras la lleva
 *                      cada campo, como la firma v1)
 *   v mayor            NO se entrega. Se dice en el hilo, con la version de quien lo
 *                      manda, para que la persona sepa que tiene que actualizar. Callar
 *                      seria peor: el otro lado veria "entregado" y aqui no entra nada.
 *   v ausente          anterior a que esto existiera: se trata como 1.
 */
export const PROTOCOL = 1;

export type Reading = { entiendo: true } | { entiendo: false; por: string };

export function readVersion(v: unknown, app?: string, mia = PROTOCOL): Reading {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  if (n <= mia) return { entiendo: true };
  return {
    entiendo: false,
    por: `habla el protocolo ${n} y este spoochie entiende hasta el ${mia}`
      + (app ? ` (la otra maquina va por la ${app})` : "")
      + `. Actualiza el plugin: /plugin marketplace update edugargar`,
  };
}
