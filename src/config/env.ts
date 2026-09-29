/**
 * Carga y valida las variables de entorno necesarias para la integracion con LUX.
 *
 * Falla rapido (lanza al importar el modulo) si falta alguna variable obligatoria, en vez
 * de fallar mas tarde con un error confuso en medio de una peticion.
 *
 * IMPORTANTE: este modulo nunca debe loguear el contenido de LUX_PASSWORD.
 */

export interface AppConfig {
  luxBaseUrl: string;
  luxUsername: string;
  luxPassword: string;
  luxWarehouse: string;
  luxTimeoutMs: number;
  luxRefreshMarginMs: number;
  luxCatalogCacheTtlMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port: number;
  nodeEnv: string;
  /** Clave compartida que deben enviar (cabecera "X-Api-Key") los consumidores internos de AZA
   *  para poder llamar a la API HTTP propia (/api/*). Nunca se loguea. */
  azaApiKey: string;
  /** Secreto usado por express-session para firmar la cookie de sesion de la interfaz web de
   *  almacen (/almacen/*). Totalmente independiente de AZA_API_KEY (esa protege /api/*, un
   *  sistema de autenticacion maquina-a-maquina distinto). Nunca se loguea. */
  sessionSecret: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireString(name: string, raw: NodeJS.ProcessEnv): string {
  const value = raw[name];
  if (value === undefined || value === null || value.trim() === '') {
    throw new ConfigError(`Falta la variable de entorno obligatoria: ${name}`);
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
    throw new ConfigError(`La variable de entorno ${name} debe ser un entero positivo`);
  }
  return parsed;
}

function parseLogLevel(raw: NodeJS.ProcessEnv): AppConfig['logLevel'] {
  const value = (raw.LOG_LEVEL ?? 'info').toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  throw new ConfigError('LOG_LEVEL debe ser uno de: debug, info, warn, error');
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const luxBaseUrlRaw = requireString('LUX_BASE_URL', raw);
  return {
    luxBaseUrl: luxBaseUrlRaw.replace(/\/+$/, ''),
    luxUsername: requireString('LUX_USERNAME', raw),
    luxPassword: requireString('LUX_PASSWORD', raw),
    luxWarehouse: requireString('LUX_WAREHOUSE', raw),
    luxTimeoutMs: optionalInt('LUX_TIMEOUT_MS', raw, 10_000),
    luxRefreshMarginMs: optionalInt('LUX_REFRESH_MARGIN_MS', raw, 60_000),
    luxCatalogCacheTtlMs: optionalInt('LUX_CATALOG_CACHE_TTL_MS', raw, 300_000),
    logLevel: parseLogLevel(raw),
    port: optionalInt('PORT', raw, 3000),
    nodeEnv: raw.NODE_ENV ?? 'development',
    azaApiKey: requireString('AZA_API_KEY', raw),
    sessionSecret: requireString('SESSION_SECRET', raw),
  };
}

export { ConfigError };
