/**
 * Jerarquia de errores de la integracion con LUX.
 *
 * Ninguna subclase debe llevar en su mensaje ni en sus propiedades: password, JWT,
 * refreshToken o el header Authorization.
 */
export abstract class LuxError extends Error {
  readonly correlationId?: string;

  protected constructor(message: string, correlationId?: string) {
    super(message);
    this.name = new.target.name;
    this.correlationId = correlationId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Error de red: timeout, connection refused/reset, DNS. Potencialmente transitorio. */
export class LuxNetworkError extends LuxError {
  /** Causa original (p.ej. AxiosError de red). No usa el nombre `cause` para no chocar con
   *  la propiedad estandar `Error.cause` de ES2022. */
  readonly networkCause?: unknown;

  constructor(message: string, networkCause?: unknown, correlationId?: string) {
    super(message, correlationId);
    this.networkCause = networkCause;
  }
}

/** Error HTTP no-2xx devuelto por LUX (401/403/404/500...) sin ser un fallo funcional. */
export class LuxHttpError extends LuxError {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown, correlationId?: string) {
    super(message, correlationId);
    this.status = status;
    this.body = body;
  }

  /** true si el status sugiere un fallo transitorio (5xx) reintentable. */
  get isTransient(): boolean {
    return this.status >= 500 && this.status < 600;
  }
}

/** Fallos de autenticacion: credenciales incorrectas, refresh invalido/expirado. */
export class LuxAuthError extends LuxError {
  constructor(message: string, correlationId?: string) {
    super(message, correlationId);
  }
}

/**
 * Error funcional de negocio devuelto por Whales dentro de un HTTP 200, mediante
 * `mensaje !== "OK"`. Nunca se reintenta automaticamente.
 */
export class LuxFunctionalError extends LuxError {
  readonly mensaje: string;
  readonly campo?: string;
  readonly tab?: string;

  constructor(mensaje: string, campo?: string, tab?: string, correlationId?: string) {
    super(`Error funcional LUX: ${mensaje}`, correlationId);
    this.mensaje = mensaje;
    this.campo = campo;
    this.tab = tab;
  }
}

/** Error de validacion local de AZA, antes de llamar a LUX (procedimiento no permitido, etc). */
export class LuxValidationError extends LuxError {
  readonly details?: unknown;

  constructor(message: string, details?: unknown, correlationId?: string) {
    super(message, correlationId);
    this.details = details;
  }
}
