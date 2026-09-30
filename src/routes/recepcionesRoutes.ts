import { Router } from 'express';
import { createRecepcionesController } from '../controllers/recepcionesController';
import type { RecepcionesService } from '../services/recepciones';
import type { CatalogosService } from '../services/catalogos';

export function createRecepcionesRouter(service: RecepcionesService, catalogosService: CatalogosService): Router {
  const router = Router();
  const controller = createRecepcionesController(service, catalogosService);

  router.get('/', controller.listar);
  router.post('/', controller.crear);
  router.get('/datos-extra', controller.obtenerDatosExtraPorPropietario);
  router.get('/:idAlbaran', controller.obtenerDetalle);
  router.put('/:idAlbaran', controller.actualizar);
  router.get('/:idAlbaran/lineas', controller.obtenerLineas);
  router.post('/:idAlbaran/lineas', controller.crearLinea);
  router.put('/:idAlbaran/lineas/:idLinea', controller.actualizarLinea);

  return router;
}
