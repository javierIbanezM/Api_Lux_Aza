import type { Request } from 'express';
import { isValidWarehouse, WAREHOUSES } from '../lux/warehouses';
import { LuxValidationError } from '../lux/errors';

/**
 * Lee la cabecera "Almacen" de una peticion entrante a /api/* (misma convencion que usa LUX
 * hacia nosotros, ver docs/lux-api-analysis.md §2.3). Si no viene, devuelve undefined: LuxClient
 * usara entonces el almacen por defecto de la configuracion (LUX_WAREHOUSE). Si viene pero no es
 * uno de los almacenes conocidos (src/lux/warehouses.ts), se rechaza ANTES de llamar a LUX.
 */
export function resolveAlmacen(req: Request): string | undefined {
  const raw = req.header('Almacen');
  if (!raw) {
    return undefined;
  }
  if (!isValidWarehouse(raw)) {
    throw new LuxValidationError(`Almacen no valido: "${raw}". Validos: ${WAREHOUSES.join(', ')}`);
  }
  return raw;
}
