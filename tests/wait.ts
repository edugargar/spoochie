/**
 * La espera de los tests que levantan demonios de verdad.
 *
 * Todos tenian su propia copia de `hasta()` con un presupuesto fijo en milisegundos.
 * Eso funciona en una maquina en reposo y falla en una cargada, y el fallo no dice
 * "esto tarda mas", dice "esto no paso": una pasada de la suite con otra encima dio 2
 * fallos y tardo 86 s donde normalmente tarda 48. Cuatro pasadas en paralelo, cada una a
 * 48 s, pasaron enteras. O sea que lo que se rompe es el presupuesto, no la logica.
 *
 * SPOOCHIE_TEST_SLOW multiplica todos los plazos a la vez. En una maquina lenta o en un
 * CI compartido, `SPOOCHIE_TEST_SLOW=3 bun test` en vez de subir numeros a mano en
 * ocho ficheros y olvidarse de la mitad.
 */
export const LENTO = Math.max(1, Number(process.env.SPOOCHIE_TEST_SLOW ?? 1) || 1);

export const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Espera a que algo sea cierto. Devuelve si lo fue, para poder afirmarlo. */
export async function hasta(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const tope = ms * LENTO;
  for (let i = 0; i < tope / 50; i++) {
    if (await pred()) return true;
    await dormir(50);
  }
  return await pred();
}

/**
 * El plazo de un test, ya multiplicado.
 *
 * LENTO escalaba las esperas de `hasta()` pero no el plazo de cada test, que es un
 * numero suelto al final de la funcion. O sea que la promesa de "un solo mando para una
 * maquina lenta" estaba a medias: los sondeos se estiraban y el corte seguia donde
 * estaba. Medido con ocho procesos comiendo CPU: cuatro tests en rojo, y el de fugas
 * decia `status: null` porque bun lo corto a los 5.000 ms por defecto, no porque el
 * comprobador fallara.
 *
 * Los que no ponen plazo se quedan con los 5 s de bun. Eso vale para un test que solo
 * calcula; el que lanza procesos pone el suyo con esto.
 */
export const plazo = (ms: number) => ms * LENTO;
