import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebDb, type WebDb } from '../../src/web/db';
import { createUser, verifyCredentials } from '../../src/web/users';

describe('web/users', () => {
  let db: WebDb;

  beforeEach(() => {
    db = createWebDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('createUser guarda un hash bcrypt, nunca la contrasena en texto plano', async () => {
    await createUser('almacen1', 'password-seria-123', db);

    const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('almacen1') as
      | { password_hash: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row!.password_hash).not.toBe('password-seria-123');
    expect(row!.password_hash.startsWith('$2')).toBe(true); // prefijo tipico de un hash bcrypt
  });

  it('verifyCredentials devuelve el usuario si la contrasena es correcta', async () => {
    await createUser('almacen1', 'password-seria-123', db);

    const user = await verifyCredentials('almacen1', 'password-seria-123', db);

    expect(user).not.toBeNull();
    expect(user!.username).toBe('almacen1');
  });

  it('verifyCredentials devuelve null si la contrasena es incorrecta', async () => {
    await createUser('almacen1', 'password-seria-123', db);

    const user = await verifyCredentials('almacen1', 'password-incorrecta', db);

    expect(user).toBeNull();
  });

  it('verifyCredentials devuelve null si el usuario no existe', async () => {
    const user = await verifyCredentials('no-existe', 'cualquiera', db);

    expect(user).toBeNull();
  });

  it('createUser sobre un usuario existente actualiza la contrasena en vez de fallar', async () => {
    const first = await createUser('almacen1', 'password-vieja-123', db);
    const second = await createUser('almacen1', 'password-nueva-456', db);

    expect(second.id).toBe(first.id);

    const conVieja = await verifyCredentials('almacen1', 'password-vieja-123', db);
    const conNueva = await verifyCredentials('almacen1', 'password-nueva-456', db);

    expect(conVieja).toBeNull();
    expect(conNueva).not.toBeNull();
  });
});
