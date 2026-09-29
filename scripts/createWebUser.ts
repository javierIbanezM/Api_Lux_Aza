/**
 * Script CLI para crear (o resetear la contrasena de) un usuario de la interfaz web de almacen.
 *
 * Uso:
 *   npm run create-web-user -- <usuario> <password>
 *
 * Si el usuario ya existe, actualiza su contrasena en vez de fallar. Nunca imprime la
 * contrasena ni el hash en la salida.
 */
import { createUser } from '../src/web/users';
import { closeWebDb } from '../src/web/db';

async function main(): Promise<void> {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error('Uso: npm run create-web-user -- <usuario> <password>');
    process.exitCode = 1;
    return;
  }

  if (password.length < 8) {
    console.error('La contrasena debe tener al menos 8 caracteres.');
    process.exitCode = 1;
    return;
  }

  const user = await createUser(username, password);
  console.log(`Usuario "${user.username}" (id=${user.id}) creado/actualizado correctamente.`);
}

main()
  .catch((err) => {
    console.error('No se pudo crear/actualizar el usuario:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeWebDb();
  });
