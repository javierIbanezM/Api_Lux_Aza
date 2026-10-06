import { Router, type NextFunction, type Request, type Response } from 'express';
import type { ExpedicionesService } from '../services/expediciones';
import type { RecepcionesService } from '../services/recepciones';
import type { CatalogosService } from '../services/catalogos';
import type { Logger } from '../logging';
import { verifyCredentials } from './users';
import { getWebDb, type WebDb } from './db';
import { requireWebSession } from './requireWebSession';
import { buildSortLinks, normalizeSortDirection, sortRows } from './sorting';
import { isValidWarehouse, WAREHOUSES } from '../lux/warehouses';

export interface WebRouterDependencies {
  expedicionesService: ExpedicionesService;
  recepcionesService: RecepcionesService;
  catalogosService: CatalogosService;
  logger: Logger;
  /** Almacen por defecto al iniciar sesion (config.luxWarehouse), hasta que el usuario elija otro. */
  defaultAlmacen: string;
  /** Conexion SQLite de usuarios web ya abierta (pool de una sola conexion, reutilizada, nunca
   *  se abre una nueva por peticion). Por defecto la instancia compartida de `getWebDb()`;
   *  inyectable para tests con una base de datos en memoria aislada. */
  db?: WebDb;
}

/**
 * Renderiza `view` envuelta en `views/layout.ejs` (patron manual de "layout" sin dependencias
 * extra: se renderiza primero la vista interna a un string HTML y luego se inyecta como `body`
 * en el layout, que anade cabecera/nav/logout/selector de almacen cuando hay sesion iniciada).
 */
function renderPage(
  req: Request,
  res: Response,
  next: NextFunction,
  view: string,
  locals: Record<string, unknown> = {},
): void {
  req.app.render(view, locals, (err, html) => {
    if (err) {
      next(err);
      return;
    }
    res.render('layout', {
      title: (locals.title as string) ?? 'AZA Almacen',
      username: req.session?.username,
      almacen: req.session?.almacen,
      warehouses: WAREHOUSES,
      body: html,
    });
  });
}

/** Describe un error de forma segura para mostrarlo en pantalla (nunca detalles internos/LUX crudos). */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Error inesperado al consultar los datos.';
}

/**
 * Rutas de la interfaz web de almacen (/almacen/*), pensada para personas (no para sistemas):
 * login/logout con cuentas propias de AZA (ver src/web/users.ts) + listado/detalle de solo
 * lectura de expediciones y recepciones, reutilizando los mismos services que ya usa la API
 * /api/*. No crea ni edita nada, y no comparte autenticacion con /api/* (AZA_API_KEY) ni con
 * LUX_USERNAME/LUX_PASSWORD.
 *
 * El almacen activo (cabecera "Almacen" hacia LUX) se guarda en la sesion (`req.session.almacen`,
 * ver src/web/session.ts), por defecto `deps.defaultAlmacen`; se cambia con POST /set-almacen.
 */
export function createWebRouter(deps: WebRouterDependencies): Router {
  const router = Router();
  const { expedicionesService, recepcionesService, catalogosService, logger, defaultAlmacen } = deps;
  const db = deps.db ?? getWebDb();

  router.get('/login', (req: Request, res: Response, next: NextFunction) => {
    if (req.session?.userId) {
      res.redirect('/almacen/expediciones');
      return;
    }
    renderPage(req, res, next, 'login', { title: 'Iniciar sesion', error: null });
  });

  router.post('/login', (req: Request, res: Response, next: NextFunction) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      renderPage(req, res, next, 'login', {
        title: 'Iniciar sesion',
        error: 'Usuario y contrasena son obligatorios.',
      });
      return;
    }

    verifyCredentials(username, password, db)
      .then((user) => {
        if (!user) {
          logger.warn('Intento de login fallido en interfaz de almacen', {
            operacion: 'web.login',
            resultado: 'ERROR',
          });
          renderPage(req, res, next, 'login', {
            title: 'Iniciar sesion',
            error: 'Usuario o contrasena incorrectos.',
          });
          return;
        }

        req.session.regenerate((err) => {
          if (err) {
            next(err);
            return;
          }
          req.session.userId = user.id;
          req.session.username = user.username;
          req.session.almacen = defaultAlmacen;
          logger.info('Login correcto en interfaz de almacen', {
            operacion: 'web.login',
            resultado: 'OK',
          });
          res.redirect('/almacen/expediciones');
        });
      })
      .catch(next);
  });

  router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }
      res.clearCookie('aza.almacen.sid');
      res.redirect('/almacen/login');
    });
  });

  router.use(requireWebSession);

  router.post('/set-almacen', (req: Request, res: Response) => {
    const almacen = typeof req.body?.almacen === 'string' ? req.body.almacen : '';
    if (isValidWarehouse(almacen)) {
      req.session.almacen = almacen;
      logger.info('Cambio de almacen en interfaz de almacen', {
        operacion: 'web.setAlmacen',
        resultado: 'OK',
        almacen,
      });
    }
    const referer = req.get('Referer');
    // Solo redirige de vuelta a Referer si es una URL propia de /almacen (evita open redirect).
    if (referer && new URL(referer, `${req.protocol}://${req.get('host')}`).pathname.startsWith('/almacen')) {
      res.redirect(referer);
      return;
    }
    res.redirect('/almacen/expediciones');
  });

  const EXPEDICIONES_SORTABLE_FIELDS = ['id', 'pedido', 'propietario', 'clienteNombre', 'estado', 'tipo', 'fecha'];

  router.get('/expediciones', (req: Request, res: Response, next: NextFunction) => {
    const filters = {
      propietario: stringParam(req.query.propietario),
      estado: stringParam(req.query.estado),
      pedido: stringParam(req.query.pedido),
    };
    const sort = stringParam(req.query.sort);
    const dir = normalizeSortDirection(req.query.dir);
    const sortLinks = buildSortLinks('/almacen/expediciones', filters, EXPEDICIONES_SORTABLE_FIELDS, sort, dir);
    const almacen = req.session.almacen ?? defaultAlmacen;

    expedicionesService
      .listarExpediciones(filters, almacen)
      .then((expediciones) => {
        renderPage(req, res, next, 'expedicionesList', {
          title: 'Expediciones',
          expediciones: sortRows(expediciones, sort, dir),
          filters,
          sortLinks,
          error: null,
        });
      })
      .catch((err) => {
        renderPage(req, res, next, 'expedicionesList', {
          title: 'Expediciones',
          expediciones: [],
          filters,
          sortLinks,
          error: describeError(err),
        });
      });
  });

  router.get('/expediciones/:idPedido', (req: Request, res: Response, next: NextFunction) => {
    const idPedido = req.params.idPedido as string;
    const almacen = req.session.almacen ?? defaultAlmacen;

    expedicionesService
      .obtenerDetalle(idPedido, almacen)
      .then(({ cabecera, datosExtra, lineas, contenedores, resumenListado }) => {
        renderPage(req, res, next, 'expedicionDetail', {
          title: `Expedicion ${idPedido}`,
          idPedido,
          cabecera,
          datosExtra,
          lineas,
          contenedores,
          resumenListado,
          error: null,
        });
      })
      .catch((err) => {
        renderPage(req, res, next, 'expedicionDetail', {
          title: `Expedicion ${idPedido}`,
          idPedido,
          cabecera: null,
          datosExtra: null,
          lineas: [],
          contenedores: [],
          resumenListado: null,
          error: describeError(err),
        });
      });
  });

  const RECEPCIONES_SORTABLE_FIELDS = ['id', 'albaran', 'propietario', 'estado'];

  router.get('/recepciones', (req: Request, res: Response, next: NextFunction) => {
    const filters = {
      propietario: stringParam(req.query.propietario),
      estado: stringParam(req.query.estado),
      albaran: stringParam(req.query.albaran),
    };
    const sort = stringParam(req.query.sort);
    const dir = normalizeSortDirection(req.query.dir);
    const sortLinks = buildSortLinks('/almacen/recepciones', filters, RECEPCIONES_SORTABLE_FIELDS, sort, dir);
    const almacen = req.session.almacen ?? defaultAlmacen;

    recepcionesService
      .listarRecepciones(filters, almacen)
      .then((recepciones) => {
        renderPage(req, res, next, 'recepcionesList', {
          title: 'Recepciones',
          recepciones: sortRows(recepciones, sort, dir),
          filters,
          sortLinks,
          error: null,
        });
      })
      .catch((err) => {
        renderPage(req, res, next, 'recepcionesList', {
          title: 'Recepciones',
          recepciones: [],
          filters,
          sortLinks,
          error: describeError(err),
        });
      });
  });

  router.get('/recepciones/:idAlbaran', (req: Request, res: Response, next: NextFunction) => {
    const idAlbaran = req.params.idAlbaran as string;
    const almacen = req.session.almacen ?? defaultAlmacen;

    recepcionesService
      .obtenerDetalle(idAlbaran, almacen)
      .then(async ({ cabecera, datosExtra, lineas, hus, resumenListado }) => {
        // Zonas de descarga validas para el propietario de esta recepcion (p_recCabeceraAza,
        // accion=SELECT_DESCARGAS). No documentado en el PDF; confirmado por ejemplo real de
        // uso, ver docs/lux-api-analysis.md §15.
        const descargas = await catalogosService.selectDescargas(cabecera.propietario, almacen);
        renderPage(req, res, next, 'recepcionDetail', {
          title: `Recepcion ${idAlbaran}`,
          idAlbaran,
          cabecera,
          datosExtra,
          lineas,
          hus,
          resumenListado,
          descargas,
          error: null,
        });
      })
      .catch((err) => {
        renderPage(req, res, next, 'recepcionDetail', {
          title: `Recepcion ${idAlbaran}`,
          idAlbaran,
          cabecera: null,
          datosExtra: null,
          lineas: [],
          hus: [],
          resumenListado: null,
          descargas: [],
          error: describeError(err),
        });
      });
  });

  return router;
}

/** Normaliza un valor de query string a `string | undefined` (nunca array/objeto/""). */
function stringParam(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}
