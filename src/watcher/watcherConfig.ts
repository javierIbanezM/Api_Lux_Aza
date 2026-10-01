/**
 * Configuracion propia del watcher de logs de LUX (src/watcher/), separada de `AppConfig`
 * (src/config/env.ts) porque el servidor HTTP principal no necesita estas variables: solo las
 * usa el proceso independiente `npm run watch-logs` (scripts/watchLuxLogs.ts).
 */
export interface WatcherConfig {
  /** Ruta al log principal de LUX (acciones de oficina/API), p.ej. S:\TLSI\LUX\lux.log.0 */
  luxLogPath: string;
  /** Ruta al log de LUX mobile (acciones de PDA de almacen), p.ej. S:\TLSI\LUX_mobile\lux.log.0 */
  luxMobileLogPath: string;
  /** Intervalo de sondeo de ambos ficheros, en ms. */
  pollIntervalMs: number;
  /** Ventana de espera tras el ultimo evento detectado para un pedido antes de re-consultarlo
   *  (agrupa varias lineas seguidas del mismo pedido en una sola llamada a la API). */
  debounceMs: number;
  /** Carpeta donde se guarda un JSON por evento (ver src/watcher/jsonFileSink.ts), solucion
   *  provisional mientras se define el destino definitivo (paso 3, ver watcherSink.ts). */
  jsonEventsDir: string;
  /** Carpeta donde se guarda la posicion leida de cada log, para no perder eventos si el
   *  servicio se corta o el log rota mientras tanto (ver logTailer.ts). */
  stateDir: string;
}

class WatcherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatcherConfigError';
  }
}

function requireString(name: string, raw: NodeJS.ProcessEnv): string {
  const value = raw[name];
  if (value === undefined || value.trim() === '') {
    throw new WatcherConfigError(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

function optionalInt(name: string, raw: NodeJS.ProcessEnv, defaultValue: number): number {
  const value = raw[name];
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new WatcherConfigError(`La variable de entorno ${name} debe ser un entero positivo`);
  }
  return parsed;
}

function optionalString(name: string, raw: NodeJS.ProcessEnv, defaultValue: string): string {
  const value = raw[name];
  return value === undefined || value.trim() === '' ? defaultValue : value;
}

export function loadWatcherConfig(raw: NodeJS.ProcessEnv = process.env): WatcherConfig {
  return {
    luxLogPath: requireString('LUX_LOG_PATH', raw),
    luxMobileLogPath: requireString('LUX_MOBILE_LOG_PATH', raw),
    pollIntervalMs: optionalInt('WATCHER_POLL_MS', raw, 3000),
    debounceMs: optionalInt('WATCHER_DEBOUNCE_MS', raw, 5000),
    jsonEventsDir: optionalString('WATCHER_JSON_DIR', raw, 'data/watcher-events'),
    stateDir: optionalString('WATCHER_STATE_DIR', raw, 'data/watcher-state'),
  };
}

export { WatcherConfigError };
