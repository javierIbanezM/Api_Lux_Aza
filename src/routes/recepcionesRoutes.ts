import { Router } from 'express';
import { createRecepcionesController } from '../controllers/recepcionesController';
import type { RecepcionesService } from '../services/recepciones';

export function createRecepcionesRouter(service: RecepcionesService): Router {
  const router = Router();
  const controller = createRecepcionesController(service);

  router.get('/', controller.listar);
  router.post('/', controller.crear);
  router.get('/:idAlbaran', controller.obtenerDetalle);
  router.put('/:idAlbaran', controller.actualizar);
  router.get('/:idAlbaran/lineas', controller.obtenerLineas);
  router.post('/:idAlbaran/lineas', controller.crearLinea);
  router.put('/:idAlbaran/lineas/:idLinea', controller.actualizarLinea);

  return router;
}
