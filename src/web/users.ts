import bcrypt from 'bcryptjs';
import type { WebDb } from './db';
import { getWebDb } from './db';

const SALT_ROUNDS = 10;

export interface WebUser {
  id: number;
  username: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

/**
 * Crea un usuario nuevo de la interfaz web de almacen, o actualiza la contrasena si el usuario
 * ya existe (nunca falla por "usuario duplicado": este es el comportamiento que necesita el
 * script `create-web-user` para poder resetear una contrasena).
 *
 * La contrasena nunca se guarda ni se loguea en texto plano: solo su hash bcrypt.
 */
export async function createUser(
  username: string,
  password: string,
  db: WebDb = getWebDb(),
): Promise<WebUser> {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, existing.id);
    return { id: existing.id, username };
  }

  const result = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, passwordHash);
  return { id: Number(result.lastInsertRowid), username };
}

/**
 * Verifica usuario/contrasena contra el hash almacenado. Siempre compara con `bcrypt.compare`
 * (nunca comparacion de igualdad de string) y siempre devuelve `null` tanto si el usuario no
 * existe como si la contrasena es incorrecta, para no revelar por temporizacion/respuesta si un
 * nombre de usuario concreto existe o no.
 */
export async function verifyCredentials(
  username: string,
  password: string,
  db: WebDb = getWebDb(),
): Promise<WebUser | null> {
  const row = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;

  if (!row) {
    return null;
  }

  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) {
    return null;
  }

  return { id: row.id, username: row.username };
}
