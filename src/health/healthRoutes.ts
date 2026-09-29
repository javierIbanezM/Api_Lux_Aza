import { Router } from 'express';
import type { AuthManager } from '../auth';
import type { AppConfig } from '../config';
import type { Logger } from '../logging';

/**
 * Health checks. Quedan deliberadamente fuera del middleware de API key (`requireApiKey`) para
 * que el orquestador/monitor pueda seguir consultandolos sin autenticacion.
 *
 * - /health/live: el proceso responde. Nunca llama a LUX (no depende de red externa).
 * - /health/ready: valida que la configuracion es correcta y expone el estado cacheado de
 *   autenticacion (sin forzar un login nuevo en cada check).
 *
 * IMPORTANTE: al ser una ruta publica y sin autenticacion, la respuesta HTTP no debe filtrar
 * detalles de configuracion interna (p.ej. el codigo de almacen). Ese detalle, si hace falta
 * para depurar, se registra en el log interno, nunca en el body de la respuesta.
 */
export function createHealthRouter(config: AppConfig, authManager: AuthManager, logger: Logger): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.status(200).json({ status: 'up' });
  });

  router.get('/ready', (_req, res) => {
    const auth = authManager.getSessionStatus();
    const configOk = Boolean(config.luxBaseUrl && config.luxUsername && config.luxWarehouse);
    const ready = configOk;

    logger.debug('Chequeo de readiness', {
      operacion: 'health.ready',
      resultado: ready ? 'OK' : 'ERROR',
      almacen: config.luxWarehouse,
      configValida: configOk,
      autenticado: auth.authenticated,
    });

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      ready,
    });
  });

  return router;
}
