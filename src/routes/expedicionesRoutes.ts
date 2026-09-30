import { Router } from 'express';
import { createExpedicionesController } from '../controllers/expedicionesController';
import type { ExpedicionesService } from '../services/expediciones';

export function createExpedicionesRouter(service: ExpedicionesService): Router {
  const router = Router();
  const controller = createExpedicionesController(service);

  router.get('/', controller.listar);
  router.post('/', controller.crear);
  router.get('/datos-extra', controller.obtenerDatosExtraPorPropietario);
  router.get('/:idPedido', controller.obtenerDetalle);
  router.put('/:idPedido', controller.actualizar);
  router.get('/:idPedido/lineas', controller.obtenerLineas);
  router.get('/:idPedido/contenedores', controller.obtenerContenedores);
  router.post('/:idPedido/lineas', controller.crearLinea);
  router.put('/:idPedido/lineas/:idLinea', controller.actualizarLinea);

  return router;
}
