import type { Request, Response } from 'express';
import type { ExpedicionesService } from '../services/expediciones';
import { asyncHandler } from './asyncHandler';
import { resolveAlmacen } from './resolveAlmacen';
import { LuxValidationError } from '../lux/errors';

/**
 * Controlador REST propio de AZA sobre ExpedicionesService. No expone /proc como proxy: cada
 * endpoint representa una operacion de negocio de AZA.
 *
 * Todos los endpoints aceptan la cabecera opcional "Almacen" (mismos valores que
 * src/lux/warehouses.ts) para operar sobre un almacen distinto al de la configuracion por
 * defecto (LUX_WAREHOUSE).
 */
export function createExpedicionesController(service: ExpedicionesService) {
  return {
    crear: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.crearExpedicion(req.body, resolveAlmacen(req));
      res.status(201).json(resultado);
    }),

    actualizar: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.actualizarExpedicion(
        { ...req.body, idPedido: req.params.idPedido },
        resolveAlmacen(req),
      );
      res.status(200).json(resultado);
    }),

    crearLinea: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.crearLineaExpedicion(req.body, resolveAlmacen(req));
      res.status(201).json(resultado);
    }),

    actualizarLinea: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.actualizarLineaExpedicion(
        { ...req.body, id: req.params.idLinea },
        resolveAlmacen(req),
      );
      res.status(200).json(resultado);
    }),

    listar: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.listarExpediciones(req.query as Record<string, string>, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),

    /** Plantilla de datos extra para una expedicion QUE TODAVIA NO EXISTE, antes de crearla
     *  (ver docs/lux-api-analysis.md §16). Requiere `?propietario=`. Registrada ANTES de
     *  `/:idPedido` en las rutas para que "datos-extra" no se confunda con un idPedido. */
    obtenerDatosExtraPorPropietario: asyncHandler(async (req: Request, res: Response) => {
      const propietario = typeof req.query.propietario === 'string' ? req.query.propietario.trim() : '';
      if (!propietario) {
        throw new LuxValidationError('Falta el parametro "propietario" en la query string');
      }
      const resultado = await service.obtenerDatosExtraExpedicionPorPropietario(propietario, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),

    obtenerDetalle: asyncHandler(async (req: Request, res: Response) => {
      const detalle = await service.obtenerDetalle(req.params.idPedido as string, resolveAlmacen(req));
      res.status(200).json(detalle);
    }),

    obtenerLineas: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.obtenerLineasExpedicion(req.params.idPedido as string, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),

    obtenerContenedores: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.obtenerContenedoresExpedicion(
        req.params.idPedido as string,
        resolveAlmacen(req),
      );
      res.status(200).json(resultado);
    }),
  };
}
