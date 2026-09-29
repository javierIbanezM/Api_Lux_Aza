import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config';

const HEADER_NAME = 'x-api-key';

/**
 * Exige la cabecera `X-Api-Key` en todas las peticiones a la API HTTP propia de AZA
 * (`/api/*`). Se monta explicitamente solo delante de esos routers: `/health/*` debe seguir
 * siendo accesible sin autenticacion para el orquestador/monitor.
 *
 * La comparacion se hace en tiempo constante (`crypto.timingSafeEqual`) para no filtrar
 * informacion por temporizacion, incluso cuando la clave recibida tiene una longitud distinta
 * a la esperada (en ese caso se compara igualmente contra un buffer aleatorio del mismo tamano
 * que la clave recibida, para no devolver antes en el caso de longitudes distintas).
 */
export function requireApiKey(config: AppConfig) {
  const expected = Buffer.from(config.azaApiKey, 'utf-8');

  return (req: Request, res: Response, next: NextFunction): void => {
    const received = req.header(HEADER_NAME);

    if (!received || !safeCompare(received, expected)) {
      res.status(401).json({
        error: {
          type: 'UNAUTHORIZED',
          message: `Falta o es invalida la cabecera "${HEADER_NAME}"`,
        },
        correlationId: req.correlationId,
      });
      return;
    }

    next();
  };
}

/** Compara `received` contra `expected` en tiempo constante, sin lanzar por longitudes distintas. */
function safeCompare(received: string, expected: Buffer): boolean {
  const receivedBuf = Buffer.from(received, 'utf-8');
  if (receivedBuf.length !== expected.length) {
    // timingSafeEqual exige buffers de igual longitud. Comparamos igualmente contra un buffer
    // aleatorio del mismo tamano que lo recibido para no devolver el resultado antes de tiempo
    // (evita filtrar por temporizacion si la longitud coincide o no con la clave real).
    timingSafeEqual(receivedBuf, randomBytes(receivedBuf.length));
    return false;
  }
  return timingSafeEqual(receivedBuf, expected);
}
