/**
 * Configuracion propia del watcher de logs de LUX (src/watcher/), separada de `AppConfig`
 * (src/config/env.ts) porque el servidor HTTP principal no necesita estas variables: solo las
 * usa el proceso independiente `npm run watch-logs` (scripts/watchLuxLogs.ts).
 */
export interface WatcherConfig {
  /** Usuario tecnico de la API (LUX_USERNAME): las lineas de log con este usuario son consultas del
   *  propio watcher y se ignoran para no entrar en bucle (p.ej. 'rutaConsultada'). */
  luxUsername: string;
  /** Ruta al log principal de LUX (acciones de oficina/API), p.ej. S:\TLSI\LUX\lux.log.0 */
  luxLogPath: string;
  /** Ruta al log de LUX mobile (acciones de PDA de almacen), p.ej. S:\TLSI\LUX_mobile\lux.log.0 */
  luxMobileLogPath: string;
  /** Intervalo de sondeo de ambos ficheros, en ms. */
  pollIntervalMs: number;
  /** Ventana de espera tras el ultimo evento detectado para un pedido antes de re-consultarlo
   *  (agrupa varias lineas seguidas del mismo pedido en una sola llamada a la API). */
  debounceMs: number;
  /** Tope de espera del debounce desde la primera linea agrupada: aunque sigan llegando lineas del
   *  mismo pedido, se refresca como maximo a los maxWaitMs (acota la latencia). */
  maxWaitMs: number;
  /** Espera base entre reintentos de un refresco fallido por causa transitoria (LUX/red/sink);
   *  crece con cada intento (x1, x2, x3...) hasta 5 minutos. */
  retryDelayMs: number;
  /** Cada cuanto se re-consulta un DECA que aun esta incompleto (envio PENDIENTE o sin shipmentId: el
   *  envio a Docuten se crea 4-40 s despues), y cuantas veces como maximo (por defecto 15 s x 20 = 5 min). */
  decaRecheckMs: number;
  decaRecheckMax: number;
  /** Cada cuanto se vuelven a revisar las carpetas de `watcher-rutas-deca` incompletas (envio sin
   *  shipmentId o sin PDF descargado), ademas de en cada arranque. Por defecto 10 min. */
  decaPendientesMs: number;
  /** Dias, desde la creacion del DECA, durante los que se sigue su estado (ENVIADO -> FIRMADO -> entregado)
   *  para actualizar el PDF cuando Docuten lo firma. Por defecto 14. */
  decaSeguimientoDias: number;
  /** Carpeta donde se guarda un JSON por evento (ver src/watcher/jsonFileSink.ts), solucion
   *  provisional mientras se define el destino definitivo (paso 3, ver watcherSink.ts). */
  jsonEventsDir: string;
  /** Carpeta aparte donde se guardan los JSON del DECA de rutas (p_expRutasDeca): cada uno lleva
   *  la consulta hecha a la API y los datos devueltos. Por defecto data/watcher-rutas-deca. */
  rutasDecaDir: string;
  /** Cuantos ficheros del log de LUX (oficina) revisa al arrancar la busqueda de eventos del DECA
   *  (consultas de ruta y GENERAR_DECA): `lux.log.0` + los `n-1` rotados mas recientes. Por defecto
   *  3 (lux.log.0, .1 y .2). SOLO afecta a esa revision de arranque del DECA; la lectura normal del log
   *  y la recuperacion de pedidos/albaranes no cambian. */
  revisarFicherosDeca: number;
  /** Si true, al llegar a estado final (expedicion ENVIADO / preaviso CERRADO) se borra el JSON del
   *  pedido/albaran. Por defecto FALSE: de momento los JSON finales se conservan (hasta que haya un
   *  destino definitivo / BD que confirme el guardado antes de borrar). WATCHER_DELETE_FINAL_JSON=true
   *  lo reactiva. */
  borrarJsonFinales: boolean;
  /** Clave de la API de Docuten eCMR (DOCUTEN_API_KEY, cabecera X-API-KEY). Sin ella no se
   *  descargan los documentos de los envios DECA (el resto del watcher funciona igual). */
  docutenApiKey: string | undefined;
  /** URL base de la API de Docuten (por defecto el entorno de pruebas / sandbox). */
  docutenBaseUrl: string;
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

function optionalBool(name: string, raw: NodeJS.ProcessEnv, defaultValue: boolean): boolean {
  const value = raw[name]?.trim().toLowerCase();
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  throw new WatcherConfigError(`La variable de entorno ${name} debe ser true o false`);
}

function optionalString(name: string, raw: NodeJS.ProcessEnv, defaultValue: string): string {
  const value = raw[name];
  return value === undefined || value.trim() === '' ? defaultValue : value;
}

export function loadWatcherConfig(raw: NodeJS.ProcessEnv = process.env): WatcherConfig {
  return {
    luxUsername: requireString('LUX_USERNAME', raw),
    luxLogPath: requireString('LUX_LOG_PATH', raw),
    luxMobileLogPath: requireString('LUX_MOBILE_LOG_PATH', raw),
    pollIntervalMs: optionalInt('WATCHER_POLL_MS', raw, 1000),
    debounceMs: optionalInt('WATCHER_DEBOUNCE_MS', raw, 2000),
    maxWaitMs: optionalInt('WATCHER_MAX_WAIT_MS', raw, 15000),
    retryDelayMs: optionalInt('WATCHER_RETRY_MS', raw, 30000),
    decaRecheckMs: optionalInt('WATCHER_DECA_RECHECK_MS', raw, 15000),
    decaRecheckMax: optionalInt('WATCHER_DECA_RECHECK_MAX', raw, 20),
    decaPendientesMs: optionalInt('WATCHER_DECA_PENDIENTES_MS', raw, 600_000),
    decaSeguimientoDias: optionalInt('WATCHER_DECA_SEGUIMIENTO_DIAS', raw, 14),
    jsonEventsDir: optionalString('WATCHER_JSON_DIR', raw, 'data/watcher-events'),
    rutasDecaDir: optionalString('WATCHER_RUTAS_DECA_DIR', raw, 'data/watcher-rutas-deca'),
    revisarFicherosDeca: optionalInt('WATCHER_REVISAR_FICHEROS_DECA', raw, 3),
    borrarJsonFinales: optionalBool('WATCHER_DELETE_FINAL_JSON', raw, false),
    docutenApiKey: raw.DOCUTEN_API_KEY?.trim() || undefined,
    docutenBaseUrl: optionalString('DOCUTEN_BASE_URL', raw, 'https://ecmr-sandbox.docuten.com/api/v1').replace(/\/+$/, ''),
    stateDir: optionalString('WATCHER_STATE_DIR', raw, 'data/watcher-state'),
  };
}

export { WatcherConfigError };
