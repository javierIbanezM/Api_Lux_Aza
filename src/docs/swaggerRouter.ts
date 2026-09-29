import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import swaggerUi from 'swagger-ui-express';

/**
 * Sirve la especificacion OpenAPI (docs/openapi.yaml) como interfaz interactiva en /docs.
 * Es solo documentacion/exploracion: las llamadas reales desde la UI siguen pasando por
 * requireApiKey igual que cualquier otro cliente (hay que pulsar "Authorize" e introducir la
 * X-Api-Key para poder probar los endpoints de /api/* desde aqui).
 *
 * La ruta se resuelve contra process.cwd() (no __dirname) porque la profundidad de __dirname
 * respecto a la raiz del proyecto difiere entre "tsx src/server.ts" y "node dist/src/server.js"
 * tras la compilacion; el proyecto siempre se arranca con la raiz del repo como cwd (ver README).
 */
export function createSwaggerRouter(): Router {
  const specPath = join(process.cwd(), 'docs', 'openapi.yaml');
  const spec = parse(readFileSync(specPath, 'utf-8')) as Record<string, unknown>;

  const router = Router();
  router.use('/', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'API AZA <-> LUX (Whales)' }));
  return router;
}
