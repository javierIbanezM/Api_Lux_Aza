import { Router } from 'express';
import { createCatalogosController } from '../controllers/catalogosController';
import type { CatalogosService } from '../services/catalogos';

export function createCatalogosRouter(service: CatalogosService): Router {
  const router = Router();
  const controller = createCatalogosController(service);

  router.get('/:tipo', controller.obtener);

  return router;
}
