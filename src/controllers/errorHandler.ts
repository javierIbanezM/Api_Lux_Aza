import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  LuxAuthError,
  LuxError,
  LuxFunctionalError,
  LuxHttpError,
  LuxNetworkError,
  LuxValidationError,
} from '../lux/errors';
import type { Logger } from '../logging';

interface ErrorBody {
  error: {
    type: string;
    message: string;
    details?: unknown;
  };
  correlationId?: string;
}

/**
 * Middleware de error central de Express.
 *
 * Traduce cada tipo de LuxError a un status HTTP apropiado para el consumidor de la API propia
 * de AZA, sin filtrar nunca secretos (password/JWT/refreshToken/Authorization) en el mensaje.
 */
export function createErrorHandler(logger: Logger) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const correlationId = req.correlationId;
    const { status, body } = translate(err, correlationId);

    logger.error('Error no capturado en peticion HTTP', {
      correlationId,
      resultado: 'ERROR',
      httpStatus: status,
      mensajeLux: body.error.message,
    });

    res.status(status).json(body);
  };
}

function translate(err: unknown, correlationId?: string): { status: number; body: ErrorBody } {
  if (err instanceof LuxValidationError) {
    return {
      status: 400,
      body: {
        error: { type: 'VALIDATION_ERROR', message: err.message, details: summarizeDetails(err.details) },
        correlationId,
      },
    };
  }

  if (isJsonBodyParseError(err)) {
    return {
      status: 400,
      body: {
        error: { type: 'INVALID_JSON', message: 'JSON invalido en el cuerpo de la peticion' },
        correlationId,
      },
    };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: { type: 'VALIDATION_ERROR', message: 'Datos de entrada invalidos', details: err.issues },
        correlationId,
      },
    };
  }

  if (err instanceof LuxFunctionalError) {
    return {
      status: 422,
      body: {
        error: {
          type: 'LUX_FUNCTIONAL_ERROR',
          message: err.mensaje,
          details: { campo: err.campo, tab: err.tab },
        },
        correlationId,
      },
    };
  }

  if (err instanceof LuxAuthError) {
    return {
      status: 502,
      body: {
        error: { type: 'LUX_AUTH_ERROR', message: 'Fallo de autenticacion con el sistema LUX' },
        correlationId,
      },
    };
  }

  if (err instanceof LuxNetworkError) {
    return {
      status: 503,
      body: {
        error: { type: 'LUX_NETWORK_ERROR', message: 'El sistema LUX no esta disponible temporalmente' },
        correlationId,
      },
    };
  }

  if (err instanceof LuxHttpError) {
    return {
      status: 502,
      body: {
        error: { type: 'LUX_HTTP_ERROR', message: `El sistema LUX respondio con un error (HTTP ${err.status})` },
        correlationId,
      },
    };
  }

  if (err instanceof LuxError) {
    return {
      status: 500,
      body: { error: { type: 'LUX_ERROR', message: 'Error interno de integracion con LUX' }, correlationId },
    };
  }

  return {
    status: 500,
    body: { error: { type: 'INTERNAL_ERROR', message: 'Error interno inesperado' }, correlationId },
  };
}

/**
 * Detecta el `SyntaxError` que lanza `express.json()` (body-parser) cuando el body de la
 * peticion no es JSON valido. Esas versiones marcan el error con `status`/`statusCode === 400`
 * y `type === 'entity.parse.failed'`; sin este chequeo caeria en el 500 generico de abajo.
 */
function isJsonBodyParseError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) {
    return false;
  }
  const withMeta = err as SyntaxError & { status?: number; statusCode?: number; type?: string };
  return (withMeta.status === 400 || withMeta.statusCode === 400) && withMeta.type === 'entity.parse.failed';
}

/** Evita propagar objetos zod internos completos si no hacen falta; se queda con lo esencial. */
function summarizeDetails(details: unknown): unknown {
  if (details instanceof ZodError) {
    return details.issues;
  }
  return details;
}
