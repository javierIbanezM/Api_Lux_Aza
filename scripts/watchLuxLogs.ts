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
import { loadConfig } from '../src/config';
import { loadWatcherConfig } from '../src/watcher/watcherConfig';
import { createLogger } from '../src/logging';
import { buildDependencies } from '../src/app';
import { LuxActionWatcher } from '../src/watcher/luxActionWatcher';

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
  // Paso 3 del flujo (evento detectado -> llamada API -> persistir en destino AZA): pendiente de
  // que AZA facilite la base de datos/sistema destino (ver src/watcher/watcherSink.ts). Cuando
  // este disponible, se implementa un WatcherSink y se pasa aqui como 6º argumento; sin el, el
  // watcher sigue funcionando igual que hasta ahora (solo registra en el log).
  const watcher = new LuxActionWatcher(
    watcherConfig,
    deps.luxClient,
    deps.expedicionesService,
    deps.recepcionesService,
    logger,
  );

  watcher.start();

  const shutdown = (signal: string): void => {
    logger.info('Watcher de logs LUX detenido', {
      operacion: 'watcher.stop',
      resultado: 'OK',
      signal,
    });
    watcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap();
