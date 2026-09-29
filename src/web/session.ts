import session, { type SessionOptions } from 'express-session';
import type { AppConfig } from '../config';

// Aumenta los tipos de express-session con los campos propios que guarda esta interfaz web.
// Unico punto del proyecto donde se declara esta forma de SessionData.
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    /** Almacen (cabecera "Almacen" de LUX) seleccionado por el usuario para esta sesion. */
    almacen?: string;
  }
}

/**
 * Middleware de sesion para la interfaz web de almacen (/almacen/*).
 *
 * IMPORTANTE (aceptado deliberadamente para esta primera version, ver docs/architecture.md):
 * usa el `MemoryStore` por defecto de express-session (no se configura ningun `store` externo).
 * Eso significa que:
 *   - Todas las sesiones se pierden si el proceso se reinicia (el personal de almacen tendria
 *     que volver a iniciar sesion).
 *   - No escala a varias instancias/procesos del servidor (cada instancia tendria sus propias
 *     sesiones en memoria) ni sobrevive a `cluster mode` de PM2 con mas de un worker.
 * No se soluciona en esta fase; si se necesita en el futuro, migrar a un store persistente
 * (Redis, SQL Server, etc.) es un cambio localizado a este fichero.
 */
export function createWebSessionMiddleware(config: AppConfig) {
  const options: SessionOptions = {
    secret: config.sessionSecret,
    name: 'aza.almacen.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 horas de turno de almacen
      // Solo exige HTTPS en produccion; en local/desarrollo se sirve normalmente por HTTP.
      secure: config.nodeEnv === 'production',
    },
  };

  return session(options);
}
