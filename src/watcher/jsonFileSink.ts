import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logging';
import type { AlbaranActualizado, ExpedicionActualizada, WatcherSink } from './watcherSink';

/** Estados finales de una expedicion: no se esperan mas cambios, asi que no tiene sentido seguir
 *  guardando/acumulando sus JSON de eventos (confirmado por el usuario: "en ese estado ya no hay
 *  cambios y ya no sirve"). */
const ESTADOS_FINALES_EXPEDICION = new Set(['ENVIADO']);

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
 * actual). Cuando una expedicion llega a un estado final (ver `ESTADOS_FINALES_EXPEDICION`) no se
 * guarda ninguno nuevo: ya no va a haber mas cambios, asi que no aporta nada seguir teniendolo.
 */
export function createJsonFileSink(dir: string, logger: Logger): WatcherSink {
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

  return {
    onExpedicionActualizada: async (result: ExpedicionActualizada) => {
      const sufijo = `expedicion-${sanitizar(result.pedido)}`;
      await borrarFicherosDe(sufijo); // si habia uno anterior de este mismo pedido, se descarta
      if (result.estado && ESTADOS_FINALES_EXPEDICION.has(result.estado)) {
        return; // estado final: no dejamos ni el ultimo, ya no aporta nada
      }
      await guardar(sufijo, result);
    },
    onAlbaranActualizado: async (result: AlbaranActualizado) => {
      const sufijo = `recepcion-${sanitizar(result.albaran)}`;
      await borrarFicherosDe(sufijo); // si habia uno anterior de este mismo albaran, se descarta
      await guardar(sufijo, result);
    },
  };
}
