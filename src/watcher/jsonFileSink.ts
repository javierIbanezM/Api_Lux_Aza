import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buscarCarpetaDeRuta, nombreCarpetaRuta, prefijoFecha } from './carpetasDeca';
import type { Logger } from '../logging';
import type {
  AlbaranActualizado,
  DestinoPersistencia,
  ExpedicionActualizada,
  RutaDecaActualizada,
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

/** Nombre de fichero valido en Windows conservando espacios y puntos (p.ej. el que sugiere Docuten:
 *  "Porte ruta RT0001_2026_X S.L. -AZA.pdf"): quita caracteres prohibidos y rutas. */
function nombreFicheroSeguro(nombre: string): string {
  const sinControl = [...nombre].map((c) => (c.charCodeAt(0) < 32 ? '_' : c)).join('');
  const limpio = sinControl
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return limpio === '' ? 'documento' : limpio.slice(0, 180);
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
 * Con `opciones.borrarFinales = true` (WATCHER_DELETE_FINAL_JSON, por defecto FALSE) ese borrado se
 * activa; con false los estados finales se tratan como cualquier otro: se conserva el JSON mas
 * reciente del pedido/albaran (de momento no se borra nada por estado final).
 *
 * Si se pasa un `destino` (base de datos), el estado final se vuelca primero ahi y los JSON solo
 * se borran cuando el destino confirma el guardado sin errores. Si falla, se conserva el JSON mas
 * actual y se registra `watcher.jsonSink.destinoError`. Sin `destino` (situacion actual, mientras
 * AZA no lo defina) el borrado es directo, como antes.
 */
export function createJsonFileSink(
  dir: string,
  logger: Logger,
  destino?: DestinoPersistencia,
  /** Carpeta aparte para los JSON del DECA de rutas (por defecto, la misma que `dir`). */
  rutasDecaDir: string = dir,
  opciones: { borrarFinales?: boolean } = {},
): WatcherSink {
  const borrarFinales = opciones.borrarFinales ?? false;
  const dirsListos = new Map<string, Promise<void>>();
  const asegurarDir = (carpeta: string): Promise<void> => {
    let listo = dirsListos.get(carpeta);
    if (!listo) {
      listo = mkdir(carpeta, { recursive: true }).then(() => undefined);
      dirsListos.set(carpeta, listo);
    }
    return listo;
  };

  /** El timestamp va PRIMERO en el nombre de fichero (no al final) para que el orden alfabetico
   *  (el que usa cualquier explorador de ficheros, incluido el de VSCode, al ordenar "por nombre")
   *  coincida con el orden cronologico, sin tener que ordenar "por fecha de modificacion" a mano. */
  const guardar = async (sufijo: string, data: unknown, carpeta: string = dir): Promise<void> => {
    await asegurarDir(carpeta);
    const nombre = `${timestampParaNombre()}--${sufijo}.json`;
    const ruta = join(carpeta, nombre);
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
  const borrarFicherosDe = async (sufijo: string, carpeta: string = dir): Promise<void> => {
    let nombres: string[];
    try {
      nombres = await readdir(carpeta);
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
    await Promise.all(propios.map((nombre) => rm(join(carpeta, nombre))));
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

  /**
   * El JSON se nombra por numero de pedido/albaran, pero ese numero puede repetirse con DISTINTO
   * propietario (p.ej. '05102026' en AMARI, id 43360, y en ANDRANIS, id 43180). Si ya hay un JSON de ese
   * numero que pertenece a OTRO id, este se guarda aparte (`<sufijo>_<id>`) en vez de pisarlo. Todo se
   * serializa por el sufijo base, asi dos eventos simultaneos no se saltan la comprobacion.
   */
  const procesarPorId = (
    base: string,
    clave: 'idPedido' | 'idAlbaran',
    id: string | undefined,
    data: unknown,
    esFinal: boolean,
    persistir: () => Promise<void>,
  ): Promise<void> =>
    enCola(base, async () => {
      let sufijo = base;
      if (id && id !== '0') {
        try {
          const existentes = (await readdir(dir)).filter((n) => n.endsWith(`--${base}.json`)).sort();
          const ultimo = existentes.at(-1);
          if (ultimo) {
            const previo = JSON.parse(await readFile(join(dir, ultimo), 'utf-8')) as Record<string, string | undefined>;
            const idPrevio = previo[clave];
            if (idPrevio && idPrevio !== '0' && idPrevio !== id) {
              sufijo = `${base}_${sanitizar(id)}`;
            }
          }
        } catch {
          // carpeta aun inexistente o JSON ilegible: se usa el nombre base
        }
      }
      await procesarSinCola(sufijo, data, esFinal, persistir);
    });

  return {
    onExpedicionActualizada: (result: ExpedicionActualizada) =>
      procesarPorId(
        `expedicion-${sanitizar(result.pedido)}`,
        'idPedido',
        result.idPedido,
        result,
        borrarFinales && Boolean(result.estado && ESTADOS_FINALES_EXPEDICION.has(result.estado)),
        () => (destino as DestinoPersistencia).guardarExpedicion(result),
      ),
    onAlbaranActualizado: (result: AlbaranActualizado) =>
      procesarPorId(
        `recepcion-${sanitizar(result.albaran)}`,
        'idAlbaran',
        result.idAlbaran,
        result,
        borrarFinales && Boolean(result.estado && ESTADOS_FINALES_RECEPCION.has(result.estado)),
        () => (destino as DestinoPersistencia).guardarAlbaran(result),
      ),
    // DECA de una ruta consultada: un JSON por ruta (el mas reciente), sin estado final.
    onRutaDecaActualizada: async (result: RutaDecaActualizada) => {
      const nombreRuta = sanitizar(result.numeroRuta);
      const sufijo = `rutadeca-${nombreRuta}`;
      await enCola(sufijo, async () => {
        // Una carpeta por ruta, con la FECHA DE CREACION DEL DECA delante (`<fecha>--<ruta>`) para que
        // el explorador las ordene cronologicamente. Dentro: el JSON (con la consulta a la API y los
        // datos) y los ficheros descargados de Docuten. Si ya existe con otro nombre (esquema antiguo,
        // sin fecha, o fecha distinta) se renombra en vez de crear una segunda.
        const respaldo = Date.parse(result.consultadoEn);
        const deseada = nombreCarpetaRuta(
          prefijoFecha(result.deca.map((x) => x.fechaCreacion), Number.isNaN(respaldo) ? Date.now() : respaldo),
          nombreRuta,
        );
        const existente = await buscarCarpetaDeRuta(rutasDecaDir, nombreRuta);
        let nombreCarpeta = existente ?? deseada;
        if (existente && existente !== deseada) {
          try {
            await rename(join(rutasDecaDir, existente), join(rutasDecaDir, deseada));
            nombreCarpeta = deseada;
          } catch {
            // destino ocupado o en uso: se sigue usando la carpeta que ya existe
          }
        }
        const carpetaRuta = join(rutasDecaDir, nombreCarpeta);
        await mkdir(carpetaRuta, { recursive: true });
        const { descargas, ...resto } = result;
        const metadatos = [];
        // Una ruta puede tener VARIOS envios DECA (p.ej. uno ANULADO y otro FIRMADO tras volver a
        // generarlo, o AZA y PROP) y todos sus PDF se llaman igual ("Porte ruta <ruta>-AZA.pdf"):
        // cuando hay mas de un envio con documentos, cada nombre lleva el id y el estado de SU envio,
        // para que ninguno pise a otro.
        const estadoDe = new Map(result.deca.map((x) => [x.shipmentId, x.estado]));
        const enviosConDocumentos = new Set(
          descargas.filter((d) => (d.documentos?.length ?? 0) > 0 || d.datos).map((d) => d.shipmentId),
        );
        const variosEnvios = enviosConDocumentos.size > 1;
        const conSufijo = (nombre: string, sufijoNombre: string): string => {
          const punto = nombre.lastIndexOf('.');
          return punto > 0 ? `${nombre.slice(0, punto)}${sufijoNombre}${nombre.slice(punto)}` : `${nombre}${sufijoNombre}`;
        };
        // Nombre -> huella de lo ya escrito en ESTA pasada: las dos variantes (include=all y simple)
        // suelen devolver el mismo documento y no se duplica el fichero.
        const escritos = new Map<string, string>();
        const guardarFichero = async (nombreDeseado: string, datos: Buffer, variante: string, shipmentId: string): Promise<string> => {
          const huella = createHash('sha256').update(datos).digest('hex');
          let nombre = nombreFicheroSeguro(nombreDeseado);
          if (variosEnvios) {
            const estado = estadoDe.get(shipmentId);
            nombre = conSufijo(nombre, ` [${shipmentId.slice(0, 8)}${estado ? ` ${estado}` : ''}]`);
          }
          // Mismo nombre pero contenido distinto (p.ej. una variante devuelve otro documento): se
          // distingue por la variante y, si aun asi coincide, por un contador. Nunca se pisa nada.
          if (escritos.has(nombre) && escritos.get(nombre) !== huella) {
            nombre = conSufijo(nombre, ` (${variante})`);
          }
          for (let n = 2; escritos.has(nombre) && escritos.get(nombre) !== huella; n += 1) {
            nombre = conSufijo(nombreFicheroSeguro(nombreDeseado), ` (${n})`);
          }
          if (escritos.get(nombre) !== huella) {
            await writeFile(join(carpetaRuta, nombre), datos);
            escritos.set(nombre, huella);
            logger.info('Documento de Docuten guardado', {
              operacion: 'watcher.jsonSink.documentoGuardado',
              resultado: 'OK',
              ruta: join(carpetaRuta, nombre),
              bytes: datos.length,
            });
          }
          return nombre;
        };
        for (const d of descargas) {
          const { datos, documentos, ...meta } = d;
          const ficheros: Array<{ fichero: string; documentType?: string; bytes: number }> = [];
          for (const [i, doc] of (documentos ?? []).entries()) {
            const nombre = doc.fileName || `docuten-${d.shipmentId}-${d.variante}-${i + 1}.pdf`;
            ficheros.push({ fichero: await guardarFichero(nombre, doc.datos, d.variante, d.shipmentId), documentType: doc.documentType, bytes: doc.bytes });
          }
          if (datos) {
            const nombre = `docuten-${d.shipmentId}-${d.variante}.${d.extension}`;
            ficheros.push({ fichero: await guardarFichero(nombre, datos, d.variante, d.shipmentId), bytes: datos.length });
          }
          metadatos.push({ ...meta, ficheros });
        }
        // La carpeta refleja el ultimo estado: se retiran los PDF de pasadas anteriores que ya no
        // corresponden (p.ej. nombres de un esquema antiguo). Solo si esta pasada guardo algo.
        if (escritos.size > 0) {
          for (const existente of await readdir(carpetaRuta)) {
            if (existente.toLowerCase().endsWith('.pdf') && !escritos.has(existente)) {
              await rm(join(carpetaRuta, existente));
            }
          }
        }
        await borrarFicherosDe(sufijo, carpetaRuta);
        await guardar(sufijo, { ...resto, descargas: metadatos }, carpetaRuta);
      });
    },
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
