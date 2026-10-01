import type { Request, Response } from 'express';
import type { RecepcionesService } from '../services/recepciones';
import type { CatalogosService } from '../services/catalogos';
import { asyncHandler } from './asyncHandler';
import { resolveAlmacen } from './resolveAlmacen';
import { LuxValidationError } from '../lux/errors';

/**
 * Todos los endpoints aceptan la cabecera opcional "Almacen" (mismos valores que
 * src/lux/warehouses.ts) para operar sobre un almacen distinto al de la configuracion por
 * defecto (LUX_WAREHOUSE).
 */
export function createRecepcionesController(service: RecepcionesService, catalogosService: CatalogosService) {
  return {
    crear: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.crearRecepcion(req.body, resolveAlmacen(req));
      res.status(201).json(resultado);
    }),

    actualizar: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.actualizarRecepcion(
        { ...req.body, idAlbaran: req.params.idAlbaran },
        resolveAlmacen(req),
      );
      res.status(200).json(resultado);
    }),

    crearLinea: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.crearLineaRecepcion(req.body, resolveAlmacen(req));
      res.status(201).json(resultado);
    }),

    actualizarLinea: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.actualizarLineaRecepcion(
        { ...req.body, id: req.params.idLinea },
        resolveAlmacen(req),
      );
      res.status(200).json(resultado);
    }),

    listar: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.listarRecepciones(req.query as Record<string, string>, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),

    /** Plantilla de datos extra para una recepcion QUE TODAVIA NO EXISTE, antes de crearla (ver
     *  docs/lux-api-analysis.md §16). Requiere `?propietario=`. Registrada ANTES de `/:idAlbaran`
     *  en las rutas para que "datos-extra" no se confunda con un idAlbaran. */
    obtenerDatosExtraPorPropietario: asyncHandler(async (req: Request, res: Response) => {
      const propietario = typeof req.query.propietario === 'string' ? req.query.propietario.trim() : '';
      if (!propietario) {
        throw new LuxValidationError('Falta el parametro "propietario" en la query string');
      }
      const resultado = await service.obtenerDatosExtraRecepcionPorPropietario(propietario, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),

    obtenerDetalle: asyncHandler(async (req: Request, res: Response) => {
      const idAlbaran = req.params.idAlbaran as string;
      const almacen = resolveAlmacen(req);
      const { cabecera, datosExtra, lineas } = await service.obtenerDetalle(idAlbaran, almacen);
      // Zonas de descarga validas para el propietario de esta recepcion (p_recCabeceraAza,
      // accion=SELECT_DESCARGAS). No documentado en el PDF del proveedor; confirmado por ejemplo
      // real de uso, ver docs/lux-api-analysis.md §15.
      const descargas = await catalogosService.selectDescargas(cabecera.propietario, almacen);
      res.status(200).json({ cabecera, datosExtra, lineas, descargas });
    }),

    obtenerLineas: asyncHandler(async (req: Request, res: Response) => {
      const resultado = await service.obtenerLineasRecepcion(req.params.idAlbaran as string, resolveAlmacen(req));
      res.status(200).json(resultado);
    }),
  };
}
