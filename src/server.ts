// Debe ser el primer import: carga .env en process.env antes de que loadConfig() lo lea.
// Sin esto, arrancar con "npm run dev"/"npm start" directamente en una terminal que no haya
// cargado .env a mano (p.ej. PowerShell) fallaba con "Falta la variable de entorno obligatoria".
import 'dotenv/config';
import { loadConfig } from './config';
import { createLogger } from './logging';
import { buildDependencies, createApp } from './app';

function bootstrap(): void {
  const logger = createLogger((process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Fallo rapido: configuracion invalida no debe arrancar el servicio.
    // eslint-disable-next-line no-console
    console.error(`No se pudo arrancar: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const deps = buildDependencies(config, logger);
  const app = createApp(config, logger, deps);

  app.listen(config.port, () => {
    logger.info('Servidor AZA <-> LUX iniciado', {
      operacion: 'server.start',
      resultado: 'OK',
    });
    // eslint-disable-next-line no-console
    console.log(`API WHALES AZA escuchando en http://localhost:${config.port}`);
  });
}

bootstrap();
