import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logging';
import type { AlbaranActualizado, ExpedicionActualizada, WatcherSink } from './watcherSink';

/** Estados finales de una expedicion: no se esperan mas cambios, asi que no tiene sentido seguir
 *  guardando/acumulando sus JSON de eventos (confirmado por el usuario: "en ese estado ya no hay
 *  cambios y ya no sirve"). */
const ESTADOS_FINALES_EXPEDICION = new Set(['ENVIADO']);

function timestampParaNombre(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
 * Cuando una expedicion llega a un estado final (ver `ESTADOS_FINALES_EXPEDICION`), en vez de
 * guardar un JSON mas se BORRAN todos los que hubiera de ese pedido: ya no va a haber mas cambios,
 * asi que no aporta nada seguir teniendolos por revisar.
 */
export function createJsonFileSink(dir: string, logger: Logger): WatcherSink {
  let dirListo: Promise<void> | undefined;
  const asegurarDir = (): Promise<void> => {
    if (!dirListo) {
      dirListo = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    return dirListo;
  };

  const guardar = async (nombreBase: string, data: unknown): Promise<void> => {
    await asegurarDir();
    const ruta = join(dir, `${nombreBase}.json`);
    await writeFile(ruta, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('Evento del watcher guardado en JSON', {
      operacion: 'watcher.jsonSink.guardado',
      resultado: 'OK',
      ruta,
    });
  };

  /** Borra todos los ficheros `<prefijo>*.json` de la carpeta (los eventos previos de un mismo
   *  pedido/albaran). Tolerante a que la carpeta aun no exista (nada que borrar todavia). */
  const borrarFicherosDe = async (prefijo: string): Promise<void> => {
    let nombres: string[];
    try {
      nombres = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
    const propios = nombres.filter((nombre) => nombre.startsWith(prefijo) && nombre.endsWith('.json'));
    if (propios.length === 0) {
      return;
    }
    await Promise.all(propios.map((nombre) => rm(join(dir, nombre))));
    logger.info('Ficheros de eventos del watcher borrados (pedido en estado final, ya no hay mas cambios)', {
      operacion: 'watcher.jsonSink.borrado',
      resultado: 'OK',
      cantidad: propios.length,
      prefijo,
    });
  };

  return {
    onExpedicionActualizada: async (result: ExpedicionActualizada) => {
      const prefijo = `expedicion-${sanitizar(result.pedido)}-`;
      if (result.estado && ESTADOS_FINALES_EXPEDICION.has(result.estado)) {
        await borrarFicherosDe(prefijo);
        return;
      }
      await guardar(`${prefijo}${timestampParaNombre()}`, result);
    },
    onAlbaranActualizado: (result: AlbaranActualizado) =>
      guardar(`recepcion-${sanitizar(result.albaran)}-${timestampParaNombre()}`, result),
  };
}
