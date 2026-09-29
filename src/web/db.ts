import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Base de datos SQLite embebida (sin servidor aparte) donde viven las cuentas de usuario de la
 * interfaz web de almacen (/almacen/*). Totalmente separada de SQL Server/LUX: esto NO son
 * cuentas de LUX ni la AZA_API_KEY, son cuentas nuevas solo para el personal que usa estas
 * pantallas.
 *
 * La ruta se resuelve contra process.cwd() (no __dirname), igual que docs/openapi.yaml en
 * src/docs/swaggerRouter.ts, porque el proyecto siempre se arranca con la raiz del repo como
 * cwd (ver README) tanto en "tsx src/server.ts" como en "node dist/src/server.js".
 */
export const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'web-users.sqlite3');

export type WebDb = Database.Database;

/**
 * Crea (o abre) la base de datos de usuarios web y garantiza el esquema. Se puede llamar varias
 * veces con rutas distintas (p.ej. ":memory:" en tests) sin afectar a la instancia compartida
 * de `getWebDb()`.
 */
export function createWebDb(dbPath: string = DEFAULT_DB_PATH): WebDb {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

let sharedDb: WebDb | undefined;

/**
 * Instancia unica (singleton, pool de una sola conexion ya que better-sqlite3 es sincrono y de
 * un solo fichero) reutilizada por el servidor HTTP y por el script `create-web-user`. Nunca
 * abrir una conexion nueva por peticion.
 */
export function getWebDb(): WebDb {
  if (!sharedDb) {
    sharedDb = createWebDb();
  }
  return sharedDb;
}

/** Cierra la instancia compartida (uso: scripts CLI de corta vida y limpieza en tests). */
export function closeWebDb(): void {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = undefined;
  }
}
