/**
 * Proceso independiente que vigila los logs de LUX (oficina + PDA de almacen) para detectar
 * cuando un pedido de expedicion cambia de estado, y lo re-consulta automaticamente contra la
 * API de LUX. Ver docs/lux-api-analysis.md §16 y docs/progress.md fase 24.
 *
 * Uso:
 *   npm run watch-logs
 *
 * Requiere, ademas de las variables de LUX_* habituales (.env), las propias del watcher:
 *   LUX_LOG_PATH, LUX_MOBILE_LOG_PATH (ver .env.example).
 *
 * Es un proceso separado del servidor HTTP a proposito: si el watcher falla (p.ej. la unidad de
 * red con los logs no esta disponible), no debe tirar abajo la API principal, y viceversa.
 */
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../src/config';
import { loadWatcherConfig } from '../src/watcher/watcherConfig';
import { createLogger } from '../src/logging';
import { buildDependencies } from '../src/app';
import { LuxActionWatcher } from '../src/watcher/luxActionWatcher';
import { createJsonFileSink } from '../src/watcher/jsonFileSink';
import { DocutenClient } from '../src/docuten';
import { migrarCarpetas } from '../src/watcher/carpetasDeca';

function bootstrap(): void {
  const logger = createLogger((process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info');

  let config;
  let watcherConfig;
  try {
    config = loadConfig();
    watcherConfig = loadWatcherConfig();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`No se pudo arrancar el watcher: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const deps = buildDependencies(config, logger);
  // Paso 3 del flujo (evento detectado -> llamada API completa -> persistir en destino AZA):
  // mientras no se defina el destino definitivo (base de datos u otro sistema, ver
  // src/watcher/watcherSink.ts), se usa un sink provisional que guarda cada evento como un JSON
  // individual en disco (ver src/watcher/jsonFileSink.ts), para poder revisar exactamente que
  // datos llegan antes de decidir el mapeo de campos. Carpeta configurable via WATCHER_JSON_DIR
  // (por defecto "data/watcher-events").
  // Las carpetas de salida se crean al arrancar (no al guardar el primer JSON), para que existan y se
  // puedan ver desde el primer momento aunque aun no haya llegado ningun evento.
  for (const carpeta of [watcherConfig.jsonEventsDir, watcherConfig.rutasDecaDir, watcherConfig.stateDir]) {
    mkdirSync(carpeta, { recursive: true });
  }
  const sink = createJsonFileSink(watcherConfig.jsonEventsDir, logger, undefined, watcherConfig.rutasDecaDir, {
    borrarFinales: watcherConfig.borrarJsonFinales,
  });
  // Descarga de documentos de Docuten (eCMR): solo si hay DOCUTEN_API_KEY en el .env.
  const docutenClient = watcherConfig.docutenApiKey
    ? new DocutenClient(watcherConfig.docutenBaseUrl, watcherConfig.docutenApiKey)
    : undefined;
  if (!docutenClient) {
    logger.warn('DOCUTEN_API_KEY no configurada: no se descargaran documentos de Docuten', {
      operacion: 'watcher.docutenSinClave',
      resultado: 'ERROR',
    });
  }
  const watcher = new LuxActionWatcher(
    watcherConfig,
    deps.luxClient,
    deps.expedicionesService,
    deps.recepcionesService,
    logger,
    sink,
    deps.rutasService,
    docutenClient,
  );

  // Las carpetas de rutas con el esquema antiguo (solo el nombre de la ruta) pasan a `<fecha>--<ruta>`.
  // Se hace ANTES de arrancar el watcher: una carpeta con ficheros abiertos no se puede renombrar, y
  // al arrancar el watcher empieza a escribir en ellas.
  migrarCarpetas(watcherConfig.rutasDecaDir, logger)
    .catch((err: unknown) => {
      logger.warn('No se pudo migrar las carpetas de watcher-rutas-deca', {
        operacion: 'watcher.carpetasDeca.error',
        resultado: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => watcher.start());

  const shutdown = (signal: string): void => {
    logger.info('Watcher de logs LUX detenido', {
      operacion: 'watcher.stop',
      resultado: 'OK',
      signal,
    });
    // Confirma la posicion de los logs (si no hay nada pendiente) antes de salir.
    void watcher.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // PM2 en Windows no entrega senales: con `shutdown_with_message` pide el cierre por mensaje IPC.
  process.on('message', (msg) => {
    if (msg === 'shutdown') {
      shutdown('pm2');
    }
  });
}

bootstrap();
