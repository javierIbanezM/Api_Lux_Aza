import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const HEADER_NAME = 'x-correlation-id';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

/**
 * Asigna un correlationId por peticion (reutiliza el que venga en el header si existe) para
 * poder trazar AZA -> API -> LUX -> SQL sin registrar informacion sensible.
 */
export function correlationIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(HEADER_NAME);
    const correlationId = incoming && incoming.trim() !== '' ? incoming : randomUUID();
    req.correlationId = correlationId;
    res.setHeader(HEADER_NAME, correlationId);
    next();
  };
}
