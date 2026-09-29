import type { Request, Response } from 'express';
import type { CatalogosService } from '../services/catalogos';
import { asyncHandler } from './asyncHandler';
import { resolveAlmacen } from './resolveAlmacen';
import { LuxValidationError } from '../lux/errors';

const CATALOG_HANDLERS: Record<string, (service: CatalogosService, req: Request, almacen?: string) => Promise<Record<string, string>[]>> = {
  cargas: (s, _req, a) => s.selectCargas(a),
  'service-level': (s, _req, a) => s.selectServiceLevel(a),
  // Requiere/acepta un filtro `propietario` (query string): ver docs/lux-api-analysis.md §15.
  descargas: (s, req, a) => s.selectDescargas(stringQueryParam(req, 'propietario'), a),
  transportistas: (s, _req, a) => s.selectTransportistas(a),
  propietarios: (s, _req, a) => s.selectPropietarios(a),
  tipos: (s, _req, a) => s.selectTipos(a),
  'pedido-estado': (s, _req, a) => s.pedidoEstado(a),
  'pedido-tipos': (s, _req, a) => s.pedidoTipos(a),
};

function stringQueryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

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
      const resultado = await handler(service, req, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),
  };
}
