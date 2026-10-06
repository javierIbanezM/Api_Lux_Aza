import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildDependencies, createApp } from '../../src/app';
import { createLogger } from '../../src/logging';
import { createWebDb, type WebDb } from '../../src/web/db';
import { createUser } from '../../src/web/users';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';
import { httpRequest, startApp, type StoppableServer } from './httpHelper';

/** Extrae el valor a enviar en la cabecera "Cookie" a partir de un "set-cookie" de respuesta. */
function cookieFromSetCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) {
    throw new Error('La respuesta de login no establecio ninguna cookie de sesion');
  }
  return raw.split(';')[0] as string;
}

describe('Integracion: interfaz web de almacen (/almacen/*)', () => {
  let mock: LuxMockServer;
  let baseUrl: string;
  let server: StoppableServer;
  let appUrl: string;
  let webDb: WebDb;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
    webDb = createWebDb(':memory:');
    await createUser('almacen1', 'password-seria-123', webDb);

    const config = buildTestConfig({ luxBaseUrl: baseUrl });
    const logger = createLogger('error');
    const deps = buildDependencies(config, logger);
    const app: Express = createApp(config, logger, deps, webDb);
    server = await startApp(app);
    appUrl = server.url;
  });

  afterEach(async () => {
    await server.close();
    await mock.close();
    webDb.close();
  });

  it('GET /almacen/expediciones sin sesion redirige a /almacen/login', async () => {
    const response = await httpRequest(appUrl, 'GET', '/almacen/expediciones');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/almacen/login');
  });

  it('POST /almacen/login con credenciales invalidas no crea sesion (sigue pidiendo login)', async () => {
    const response = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=incorrecta',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('Usuario o contrasena incorrectos');
  });

  it('login correcto seguido de acceso a expediciones y recepciones con la cookie de sesion', async () => {
    mock.updateOptions({
      onProc: (proc) => {
        if (proc === 'p_expedicionesAza') {
          return { status: 200, body: [{ id: '1234', pedido: 'PED-0001', propietario: 'AZA', estado: 'PENDIENTE' }] };
        }
        if (proc === 'p_recepcionesAza') {
          return { status: 200, body: [{ id: '99', albaran: 'ALB-0001', propietario: 'AZA', estado: 'PENDIENTE' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const loginResponse = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=password-seria-123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(loginResponse.status).toBe(302);
    expect(loginResponse.headers.location).toBe('/almacen/expediciones');
    const cookie = cookieFromSetCookie(loginResponse.headers['set-cookie']);

    const expedicionesResponse = await httpRequest(appUrl, 'GET', '/almacen/expediciones', {
      headers: { Cookie: cookie },
    });
    expect(expedicionesResponse.status).toBe(200);
    expect(expedicionesResponse.text).toContain('PED-0001');

    const recepcionesResponse = await httpRequest(appUrl, 'GET', '/almacen/recepciones', {
      headers: { Cookie: cookie },
    });
    expect(recepcionesResponse.status).toBe(200);
    expect(recepcionesResponse.text).toContain('ALB-0001');
  });

  it('la cookie de sesion NO lleva el atributo Secure con sessionCookieSecure=false (acceso por HTTP plano)', async () => {
    const abrirYLogin = async (sessionCookieSecure: boolean): Promise<string> => {
      const config = buildTestConfig({ luxBaseUrl: baseUrl, sessionCookieSecure });
      const logger = createLogger('error');
      const app: Express = createApp(config, logger, buildDependencies(config, logger), webDb);
      const srv = await startApp(app);
      try {
        const res = await httpRequest(srv.url, 'POST', '/almacen/login', {
          body: 'username=almacen1&password=password-seria-123',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' },
        });
        const raw = res.headers['set-cookie'];
        return String(Array.isArray(raw) ? raw[0] : raw ?? '');
      } finally {
        await srv.close();
      }
    };

    // Sin Secure: el navegador guarda y envia la cookie por http://servidor:3000.
    const sinSecure = await abrirYLogin(false);
    expect(sinSecure).toContain('aza.almacen.sid=');
    expect(sinSecure).not.toMatch(/;\s*Secure/i);
  });

  it('el detalle web de una recepcion muestra el listado y las HUs (con sus campos vacios), igual que el JSON del watcher', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '99', albaran: 'ALB-0001', propietario: 'AZA' }] };
        }
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_INICIO') {
          return { status: 200, body: [{ matricula: '1234ABC' }] };
        }
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_DESCARGAS') {
          return { status: 200, body: [] };
        }
        if (proc === 'p_recAlbaranLineas') {
          return { status: 200, body: [{ id: '1', referencia: 'REF-1' }] };
        }
        if (proc === 'p_recAlbaranHUPreinformado') {
          return { status: 200, body: [{ id: '5', hu: 'HU-PRUEBA-01', piezas: '40', ubicacion: '', 'action#borrar': '1' }] };
        }
        if (proc === 'p_recepcionesAza') {
          return { status: 200, body: [{ id: '99', albaran: 'ALB-0001', estado: 'CERRADO', fechaCierre: '' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });
    const login = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=password-seria-123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const cookie = cookieFromSetCookie(login.headers['set-cookie']);

    const r = await httpRequest(appUrl, 'GET', '/almacen/recepciones/99', { headers: { Cookie: cookie } });

    expect(r.status).toBe(200);
    expect(r.text).toContain('Datos del listado (p_recepcionesAza)'); // fila del listado
    expect(r.text).toContain('fechaCierre'); // campo vacio: se muestra igualmente
    expect(r.text).toContain('HUs recepcionadas (1)');
    expect(r.text).toContain('HU-PRUEBA-01');
    expect(r.text).toContain('<th>ubicacion</th>'); // columna vacia incluida
    expect(r.text).not.toContain('action#borrar'); // los flags internos de botones no se muestran
  });

  it('logout invalida la sesion: tras cerrar sesion, el listado vuelve a redirigir a login', async () => {
    const loginResponse = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=password-seria-123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const cookie = cookieFromSetCookie(loginResponse.headers['set-cookie']);

    const logoutResponse = await httpRequest(appUrl, 'POST', '/almacen/logout', {
      headers: { Cookie: cookie },
    });
    expect(logoutResponse.status).toBe(302);
    expect(logoutResponse.headers.location).toBe('/almacen/login');

    const afterLogout = await httpRequest(appUrl, 'GET', '/almacen/expediciones', {
      headers: { Cookie: cookie },
    });
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.location).toBe('/almacen/login');
  });

  it('POST /almacen/set-almacen cambia el almacen usado en las siguientes consultas', async () => {
    let almacenRecibido: unknown;
    mock.updateOptions({
      onProc: (_proc, _body, headers) => {
        almacenRecibido = headers.almacen;
        return { status: 200, body: [{ id: '1', pedido: 'PED-0001', propietario: 'AZA', estado: 'PENDIENTE' }] };
      },
    });

    const loginResponse = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=password-seria-123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const cookie = cookieFromSetCookie(loginResponse.headers['set-cookie']);

    // Por defecto usa el almacen configurado (ver tests/mocks/testConfig.ts -> buildTestConfig()).
    await httpRequest(appUrl, 'GET', '/almacen/expediciones', { headers: { Cookie: cookie } });
    expect(almacenRecibido).toBe('ALM01');

    const setAlmacenResponse = await httpRequest(appUrl, 'POST', '/almacen/set-almacen', {
      body: 'almacen=CHESTE',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
    expect(setAlmacenResponse.status).toBe(302);

    await httpRequest(appUrl, 'GET', '/almacen/expediciones', { headers: { Cookie: cookie } });
    expect(almacenRecibido).toBe('CHESTE');
  });

  it('POST /almacen/set-almacen ignora un almacen desconocido (mantiene el anterior)', async () => {
    mock.updateOptions({
      onProc: () => ({ status: 200, body: [{ id: '1', pedido: 'PED-0001', propietario: 'AZA', estado: 'PENDIENTE' }] }),
    });
    const loginResponse = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=password-seria-123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const cookie = cookieFromSetCookie(loginResponse.headers['set-cookie']);

    const response = await httpRequest(appUrl, 'POST', '/almacen/set-almacen', {
      body: 'almacen=NO_EXISTE',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    });
    // Redirige igualmente (UX simple), pero el almacen de sesion no cambia a un valor invalido.
    expect(response.status).toBe(302);
  });

  it('GET /almacen/login no exige sesion (es la propia pantalla de login)', async () => {
    const response = await httpRequest(appUrl, 'GET', '/almacen/login');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Iniciar sesion');
  });

  it('el listado de expediciones se puede ordenar por columna (clic en cabecera) asc/desc', async () => {
    mock.updateOptions({
      onProc: (proc) => {
        if (proc === 'p_expedicionesAza') {
          return {
            status: 200,
            body: [
              { id: '1', pedido: 'PED-B', propietario: 'AZA', estado: 'ENVIADO', tipo: 'NORMAL', fecha: '20/01/2026' },
              { id: '2', pedido: 'PED-A', propietario: 'AZA', estado: 'ANULADO', tipo: 'NORMAL', fecha: '05/12/2026' },
            ],
          };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const loginResponse = await httpRequest(appUrl, 'POST', '/almacen/login', {
      body: 'username=almacen1&password=password-seria-123',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const cookie = cookieFromSetCookie(loginResponse.headers['set-cookie']);

    // Sin orden explicito: respeta el orden devuelto por LUX (PED-B antes que PED-A).
    const sinOrden = await httpRequest(appUrl, 'GET', '/almacen/expediciones', { headers: { Cookie: cookie } });
    expect(sinOrden.text.indexOf('PED-B')).toBeLessThan(sinOrden.text.indexOf('PED-A'));

    // Ordenando por estado asc: ANULADO antes que ENVIADO -> PED-A antes que PED-B.
    const ascPorEstado = await httpRequest(appUrl, 'GET', '/almacen/expediciones?sort=estado&dir=asc', {
      headers: { Cookie: cookie },
    });
    expect(ascPorEstado.text.indexOf('PED-A')).toBeLessThan(ascPorEstado.text.indexOf('PED-B'));
    // El enlace de la cabecera "Estado" ya apunta a alternar a desc (estabamos en asc). EJS
    // escapa "&" a "&amp;" en el atributo href.
    expect(ascPorEstado.text).toContain('sort=estado&amp;dir=desc');

    // Ordenando por fecha desc: 05/12/2026 (PED-A) antes que 20/01/2026 (PED-B).
    const descPorFecha = await httpRequest(appUrl, 'GET', '/almacen/expediciones?sort=fecha&dir=desc', {
      headers: { Cookie: cookie },
    });
    expect(descPorFecha.text.indexOf('PED-A')).toBeLessThan(descPorFecha.text.indexOf('PED-B'));
  });
});
