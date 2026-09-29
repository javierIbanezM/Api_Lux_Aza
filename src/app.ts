import path from 'node:path';
import express, { type Express } from 'express';
import type { AppConfig } from './config';
import type { Logger } from './logging';
import { correlationIdMiddleware } from './logging';
import { AuthManager } from './auth';
import { LuxClient } from './lux/client';
import { ExpedicionesService } from './services/expediciones';
import { RecepcionesService } from './services/recepciones';
import { CatalogosService } from './services/catalogos';
import { createExpedicionesRouter, createRecepcionesRouter, createCatalogosRouter } from './routes';
import { createHealthRouter } from './health';
import { createErrorHandler } from './controllers/errorHandler';
import { requireApiKey } from './controllers/requireApiKey';
import { createSwaggerRouter } from './docs/swaggerRouter';
import { createWebSessionMiddleware } from './web/session';
import { createWebRouter } from './web/webRouter';
import type { WebDb } from './web/db';

export interface AppDependencies {
  authManager: AuthManager;
  luxClient: LuxClient;
  expedicionesService: ExpedicionesService;
  recepcionesService: RecepcionesService;
  catalogosService: CatalogosService;
}

/** Construye las dependencias de la aplicacion a partir de la configuracion. */
export function buildDependencies(config: AppConfig, logger: Logger): AppDependencies {
  const authManager = new AuthManager(config, logger);
  const luxClient = new LuxClient(config, authManager, logger);
  return {
    authManager,
    luxClient,
    expedicionesService: new ExpedicionesService(luxClient),
    recepcionesService: new RecepcionesService(luxClient),
    catalogosService: new CatalogosService(luxClient, config.luxCatalogCacheTtlMs),
  };
}

/**
 * Crea la app Express de AZA sobre la integracion LUX. Recibe las dependencias ya construidas
 * para poder inyectar mocks facilmente en tests de integracion.
 *
 * `webDb` (usuarios de la interfaz de almacen, /almacen/*) es inyectable por el mismo motivo:
 * los tests de integracion usan una base de datos SQLite en memoria en vez del fichero real
 * `data/web-users.sqlite3`. Por defecto se usa la instancia compartida (`getWebDb()`, ver
 * src/web/db.ts), reutilizada en todo el proceso (nunca se abre una conexion nueva por peticion).
 */
export function createApp(config: AppConfig, logger: Logger, deps: AppDependencies, webDb?: WebDb): Express {
  const app = express();

  app.use(express.json());
  app.use(correlationIdMiddleware());

  // Motor de plantillas para la interfaz web de almacen (/almacen/*, ver src/web/). La ruta se
  // resuelve contra process.cwd() (no __dirname) por el mismo motivo que docs/openapi.yaml en
  // src/docs/swaggerRouter.ts: __dirname difiere entre "tsx src/server.ts" y el build compilado.
  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'src', 'web', 'views'));

  app.use('/health', createHealthRouter(config, deps.authManager, logger));

  // Documentacion interactiva (Swagger UI) a partir de docs/openapi.yaml. Publica a proposito
  // (como /health): es solo documentacion, las llamadas reales que se hagan desde ahi contra
  // /api/* siguen exigiendo X-Api-Key igual que cualquier otro cliente.
  app.use('/docs', createSwaggerRouter());

  // La API propia de AZA exige "X-Api-Key" en todo /api/*. /health/* queda deliberadamente
  // fuera (debe seguir siendo publico para el orquestador/monitor).
  app.use('/api', requireApiKey(config));
  app.use('/api/expediciones', createExpedicionesRouter(deps.expedicionesService));
  app.use('/api/recepciones', createRecepcionesRouter(deps.recepcionesService, deps.catalogosService));
  app.use('/api/catalogos', createCatalogosRouter(deps.catalogosService));

  // Interfaz web para el personal de almacen (/almacen/*): sistema de autenticacion propio y
  // totalmente independiente de "X-Api-Key" (piensa en personas con navegador, no en sistemas).
  // Ver docs/architecture.md para el detalle de por que usa su propia sesion/usuarios.
  app.use('/almacen', express.urlencoded({ extended: false }));
  app.use('/almacen', createWebSessionMiddleware(config));
  app.use(
    '/almacen',
    createWebRouter({
      expedicionesService: deps.expedicionesService,
      recepcionesService: deps.recepcionesService,
      catalogosService: deps.catalogosService,
      logger,
      defaultAlmacen: config.luxWarehouse,
      db: webDb,
    }),
  );

  app.use(createErrorHandler(logger));

  return app;
}
