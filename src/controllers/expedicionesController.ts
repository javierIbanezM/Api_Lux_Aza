import type { Request, Response } from 'express';
import type { ExpedicionesService } from '../services/expediciones';
import { asyncHandler } from './asyncHandler';
import { resolveAlmacen } from './resolveAlmacen';

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

    obtenerDetalle: asyncHandler(async (req: Request, res: Response) => {
      const idPedido = req.params.idPedido as string;
      const almacen = resolveAlmacen(req);
      const [cabecera, datosExtra, lineas, contenedores] = await Promise.all([
        service.obtenerExpedicion(idPedido, almacen),
        service.obtenerDatosExtraExpedicion(idPedido, almacen),
        service.obtenerLineasExpedicion(idPedido, almacen),
        service.obtenerContenedoresExpedicion(idPedido, almacen),
      ]);
      // Fila completa del visor (p_expedicionesAza): columnas que no trae p_expCabeceraAza
      // (transportista, ruta, muelle, prioridad, etc.), ver docs/lux-api-analysis.md §6.3.
      const resumenListado = await service.obtenerResumenListadoExpedicion(cabecera.pedido, almacen);
      res.status(200).json({ cabecera, datosExtra, lineas, contenedores, resumenListado });
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
