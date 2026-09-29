import type { Request, Response } from 'express';
import type { CatalogosService } from '../services/catalogos';
import { asyncHandler } from './asyncHandler';
import { resolveAlmacen } from './resolveAlmacen';
import { LuxValidationError } from '../lux/errors';

const CATALOG_HANDLERS: Record<string, (service: CatalogosService, almacen?: string) => Promise<Record<string, string>[]>> = {
  cargas: (s, a) => s.selectCargas(a),
  'service-level': (s, a) => s.selectServiceLevel(a),
  descargas: (s, a) => s.selectDescargas(a),
  transportistas: (s, a) => s.selectTransportistas(a),
  propietarios: (s, a) => s.selectPropietarios(a),
  tipos: (s, a) => s.selectTipos(a),
  'pedido-estado': (s, a) => s.pedidoEstado(a),
  'pedido-tipos': (s, a) => s.pedidoTipos(a),
};

/**
 * Acepta la cabecera opcional "Almacen" (mismos valores que src/lux/warehouses.ts) igual que el
 * resto de controladores, ya que algunos catalogos (transportistas, propietarios) pueden variar
 * de un almacen a otro.
 */
export function createCatalogosController(service: CatalogosService) {
  return {
    obtener: asyncHandler(async (req: Request, res: Response) => {
      const tipo = req.params.tipo as string;
      const handler = CATALOG_HANDLERS[tipo];
      if (!handler) {
        throw new LuxValidationError(
          `Catalogo no soportado: ${tipo}. Validos: ${Object.keys(CATALOG_HANDLERS).join(', ')}`,
        );
      }
      const resultado = await handler(service, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),
  };
}
