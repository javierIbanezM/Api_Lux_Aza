/**
 * Logger estructurado (JSON por linea).
 *
 * Campos soportados: timestamp, correlationId, operacion, procedimiento, accion, almacen,
 * resultado, duracionMs, httpStatus, mensajeLux, idPedido, idAlbaran.
 *
 * REGLA DE SEGURIDAD (no negociable): este modulo nunca debe recibir ni imprimir
 * password, JWT, refreshToken, ni la cabecera Authorization. Los campos de LogFields estan
 * deliberadamente restringidos para hacer dificil que un llamador cuele un secreto por error.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Claves explicitamente prohibidas: si aparecen en extra, se redactan antes de imprimir. */
const FORBIDDEN_KEYS = new Set([
  'password',
  'pass',
  'token',
  'jwt',
  'refreshtoken',
  'authorization',
  'secret',
]);

export interface LogFields {
  correlationId?: string;
  operacion?: string;
  procedimiento?: string;
  accion?: string;
  almacen?: string;
  resultado?: 'OK' | 'ERROR' | string;
  duracionMs?: number;
  httpStatus?: number;
  mensajeLux?: string;
  idPedido?: string;
  idAlbaran?: string;
  [extra: string]: unknown;
}

function sanitize(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export class Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  private write(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitize(fields),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }
}

export function createLogger(minLevel: LogLevel = 'info'): Logger {
  return new Logger(minLevel);
}
