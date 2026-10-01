import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logging';
import type {
  AlbaranActualizado,
  DestinoPersistencia,
  ExpedicionActualizada,
  RutaEnviadaSinPedidos,
  WatcherSink,
} from './watcherSink';

/** Estados finales de una expedicion: no se esperan mas cambios, asi que no tiene sentido seguir
 *  guardando/acumulando sus JSON de eventos (confirmado por el usuario: "en ese estado ya no hay
 *  cambios y ya no sirve"). */
const ESTADOS_FINALES_EXPEDICION = new Set(['ENVIADO']);
/** Igual para recepciones (preavisos): `CERRADO` es el estado final. */
const ESTADOS_FINALES_RECEPCION = new Set(['CERRADO']);

/** Timestamp para el nombre de fichero en hora LOCAL (no UTC): `toISOString()` da UTC, que en
 *  Espana (CEST, UTC+2 en verano) va 2h por detras del reloj de pared -- confuso al revisar los
 *  ficheros a simple vista. Sin sufijo "Z" a proposito, para no dar a entender que es UTC. */
function timestampParaNombre(): string {
  const d = new Date();
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/** Evita que un pedido/albaran con caracteres raros rompa el nombre de fichero. */
function sanitizar(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Sink de watcher (ver src/watcher/watcherSink.ts) que guarda cada evento como un fichero JSON
 * individual en disco, con la informacion completa (cabecera + listado + lineas + contenedores)
 * tal cual la recibe el watcher tras la re-consulta a LUX.
 *
 * Es una solucion PROVISIONAL mientras se define el destino definitivo (base de datos u otro
 * sistema): sirve para revisar en detalle, evento a evento, que datos llegan antes de decidir el
 * mapeo de campos hacia ese destino. No sustituye al `WatcherSink` real del paso 3, es un sink mas
 * que se puede quitar/sustituir sin tocar el resto del watcher.
 *
 * Como mucho hay UN fichero por pedido/albaran: antes de guardar el nuevo se borra cualquier JSON
 * previo del mismo pedido/albaran (confirmado por el usuario: si se duplica, se queda el mas
 * actual). Cuando una expedicion (`ENVIADO`) o una recepcion (`CERRADO`) llega a su estado final
 * ya no va a haber mas cambios, asi que se borran sus JSON y no se guarda ninguno nuevo.
 *
 * Si se pasa un `destino` (base de datos), el estado final se vuelca primero ahi y los JSON solo
 * se borran cuando el destino confirma el guardado sin errores. Si falla, se conserva el JSON mas
 * actual y se registra `watcher.jsonSink.destinoError`. Sin `destino` (situacion actual, mientras
 * AZA no lo defina) el borrado es directo, como antes.
 */
export function createJsonFileSink(dir: string, logger: Logger, destino?: DestinoPersistencia): WatcherSink {
  let dirListo: Promise<void> | undefined;
  const asegurarDir = (): Promise<void> => {
    if (!dirListo) {
      dirListo = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    return dirListo;
  };

  /** El timestamp va PRIMERO en el nombre de fichero (no al final) para que el orden alfabetico
   *  (el que usa cualquier explorador de ficheros, incluido el de VSCode, al ordenar "por nombre")
   *  coincida con el orden cronologico, sin tener que ordenar "por fecha de modificacion" a mano. */
  const guardar = async (sufijo: string, data: unknown): Promise<void> => {
    await asegurarDir();
    const nombre = `${timestampParaNombre()}--${sufijo}.json`;
    const ruta = join(dir, nombre);
    await writeFile(ruta, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('Evento del watcher guardado en JSON', {
      operacion: 'watcher.jsonSink.guardado',
      resultado: 'OK',
      ruta,
    });
  };

  /** Borra todos los ficheros `*--<sufijo>.json` de la carpeta (los eventos previos de un mismo
   *  pedido/albaran, ahora que el timestamp va al principio del nombre en vez de al final).
   *  Tolerante a que la carpeta aun no exista (nada que borrar todavia). */
  const borrarFicherosDe = async (sufijo: string): Promise<void> => {
    let nombres: string[];
    try {
      nombres = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
    const propios = nombres.filter((nombre) => nombre.endsWith(`--${sufijo}.json`));
    if (propios.length === 0) {
      return;
    }
    await Promise.all(propios.map((nombre) => rm(join(dir, nombre))));
    logger.info('Ficheros de eventos del watcher borrados', {
      operacion: 'watcher.jsonSink.borrado',
      resultado: 'OK',
      cantidad: propios.length,
      sufijo,
    });
  };

  /** Cola por sufijo: dos eventos del MISMO pedido/albaran (p.ej. uno llegado por id y otro por
   *  texto) nunca se procesan a la vez, asi el segundo ve (y descarta) el fichero del primero y
   *  como mucho queda un JSON por pedido/albaran. */
  const colas = new Map<string, Promise<void>>();
  const enCola = (sufijo: string, tarea: () => Promise<void>): Promise<void> => {
    const previa = colas.get(sufijo) ?? Promise.resolve();
    const actual = previa.then(tarea, tarea);
    colas.set(sufijo, actual);
    void actual.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (colas.get(sufijo) === actual) {
        colas.delete(sufijo);
      }
    });
    return actual;
  };

  /** Guarda el JSON mas actual (descartando los previos) salvo que sea estado final; en ese
   *  caso, con `destino`, los JSON solo se borran tras la confirmacion del destino. */
  const procesarSinCola = async (
    sufijo: string,
    data: unknown,
    esFinal: boolean,
    persistir: () => Promise<void>,
  ): Promise<void> => {
    if (!esFinal) {
      await borrarFicherosDe(sufijo); // si habia uno anterior de este mismo pedido/albaran, se descarta
      await guardar(sufijo, data);
      return;
    }
    if (!destino) {
      await borrarFicherosDe(sufijo); // estado final sin destino definido: no dejamos ni el ultimo
      return;
    }
    try {
      await persistir();
    } catch (err) {
      // Sin confirmacion del destino no se borra nada: se deja el JSON mas actual.
      logger.error('El destino no confirmo el guardado del estado final; se conserva el JSON', {
        operacion: 'watcher.jsonSink.destinoError',
        resultado: 'ERROR',
        sufijo,
        error: err instanceof Error ? err.message : String(err),
      });
      await borrarFicherosDe(sufijo);
      await guardar(sufijo, data);
      return;
    }
    await borrarFicherosDe(sufijo);
  };

  const procesar = (sufijo: string, data: unknown, esFinal: boolean, persistir: () => Promise<void>): Promise<void> =>
    enCola(sufijo, () => procesarSinCola(sufijo, data, esFinal, persistir));

  return {
    onExpedicionActualizada: (result: ExpedicionActualizada) =>
      procesar(
        `expedicion-${sanitizar(result.pedido)}`,
        result,
        Boolean(result.estado && ESTADOS_FINALES_EXPEDICION.has(result.estado)),
        () => (destino as DestinoPersistencia).guardarExpedicion(result),
      ),
    onAlbaranActualizado: (result: AlbaranActualizado) =>
      procesar(
        `recepcion-${sanitizar(result.albaran)}`,
        result,
        Boolean(result.estado && ESTADOS_FINALES_RECEPCION.has(result.estado)),
        () => (destino as DestinoPersistencia).guardarAlbaran(result),
      ),
    // Ruta enviada sin pedidos en LUX: un JSON por ruta (el mas reciente), sin estado final.
    onRutaEnviadaSinPedidos: async (result: RutaEnviadaSinPedidos) => {
      const sufijo = `ruta-${sanitizar(result.idRuta)}`;
      await enCola(sufijo, async () => {
        await borrarFicherosDe(sufijo);
        await guardar(sufijo, result);
      });
    },
  };
}
