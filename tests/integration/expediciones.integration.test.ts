import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildDependencies, createApp } from '../../src/app';
import { createLogger } from '../../src/logging';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';
import { httpJson, httpRaw, startApp, type StoppableServer } from './httpHelper';

/** Clave de API usada en los tests (debe coincidir con `buildTestConfig().azaApiKey`). */
const API_KEY = 'test-api-key';
const authHeaders = { 'X-Api-Key': API_KEY };

describe('Integracion: flujo completo de alta de expedicion', () => {
  let mock: LuxMockServer;
  let baseUrl: string;
  let server: StoppableServer;
  let appUrl: string;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
    const config = buildTestConfig({ luxBaseUrl: baseUrl, azaApiKey: API_KEY });
    const logger = createLogger('error');
    const deps = buildDependencies(config, logger);
    const app: Express = createApp(config, logger, deps);
    server = await startApp(app);
    appUrl = server.url;
  });

  afterEach(async () => {
    await server.close();
    await mock.close();
  });

  it('crea una expedicion con lineas end-to-end via la API propia de AZA', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'ACTUALIZAR') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234', pedido: 'PED-0001' }] };
        }
        if (proc === 'p_expPedidoLineas' && body.accion === 'INSERT') {
          return { status: 200, body: [{ mensaje: 'OK', id: '55010' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/expediciones',
      {
        propietario: 'AZA',
        codCliente: 'C001',
        transportista: 'SEUR',
        serviceLevel: '24H',
        lineas: [{ referencia: 'REF-100', cantidadPedida: '24' }],
      },
      authHeaders,
    );

    expect(response.status).toBe(201);
    expect(response.body.idPedido).toBe('1234');
    expect(response.body.lineas.ok).toHaveLength(1);
    expect(response.body.lineas.fallidas).toHaveLength(0);
  });

  it('devuelve 422 y no crea lineas cuando la cabecera falla por error funcional', async () => {
    let lineaCalls = 0;
    mock.updateOptions({
      onProc: (proc) => {
        if (proc === 'p_expCabeceraAza') {
          return {
            status: 200,
            body: [{ mensaje: 'ERR_TRANSPORTISTA_NOT_EXISTS', campo: 'TRANSPORTISTA', tab: 'GENERAL' }],
          };
        }
        lineaCalls += 1;
        return { status: 200, body: [{ mensaje: 'OK' }] };
      },
    });

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/expediciones',
      {
        propietario: 'AZA',
        codCliente: 'C001',
        transportista: 'NO_EXISTE',
        serviceLevel: '24H',
        lineas: [{ referencia: 'REF-100', cantidadPedida: '24' }],
      },
      authHeaders,
    );

    expect(response.status).toBe(422);
    expect(response.body.error.type).toBe('LUX_FUNCTIONAL_ERROR');
    expect(response.body.error.message).toBe('ERR_TRANSPORTISTA_NOT_EXISTS');
    expect(lineaCalls).toBe(0);
  });

  it('devuelve 400 cuando falta un campo obligatorio', async () => {
    const response = await httpJson(
      appUrl,
      'POST',
      '/api/expediciones',
      {
        // falta propietario, codCliente, transportista, serviceLevel
        pedido: 'PED-X',
      },
      authHeaders,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('VALIDATION_ERROR');
  });

  it('devuelve 401 si no se envia la cabecera X-Api-Key', async () => {
    const response = await httpJson(appUrl, 'POST', '/api/expediciones', {
      propietario: 'AZA',
      codCliente: 'C001',
      transportista: 'SEUR',
      serviceLevel: '24H',
    });

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('UNAUTHORIZED');
  });

  it('devuelve 401 si la cabecera X-Api-Key es incorrecta', async () => {
    const response = await httpJson(
      appUrl,
      'GET',
      '/api/expediciones',
      undefined,
      { 'X-Api-Key': 'clave-incorrecta' },
    );

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('UNAUTHORIZED');
  });

  it('no aplica la autenticacion de API key a /health/*', async () => {
    const response = await httpJson(appUrl, 'GET', '/health/live');
    expect(response.status).toBe(200);
  });

  it('devuelve 400 (sin llamar a LUX) cuando el array de lineas supera el limite de 200', async () => {
    let lineaCabeceraCalls = 0;
    mock.updateOptions({
      onProc: () => {
        lineaCabeceraCalls += 1;
        return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234', pedido: 'PED-0001' }] };
      },
    });

    const lineas = Array.from({ length: 201 }, (_, i) => ({
      referencia: `REF-${i}`,
      cantidadPedida: '1',
    }));

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/expediciones',
      {
        propietario: 'AZA',
        codCliente: 'C001',
        transportista: 'SEUR',
        serviceLevel: '24H',
        lineas,
      },
      authHeaders,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('VALIDATION_ERROR');
    expect(lineaCabeceraCalls).toBe(0);
  });

  it('devuelve 400 (no 500) cuando el body no es JSON valido', async () => {
    const response = await httpRaw(
      appUrl,
      'POST',
      '/api/expediciones',
      '{ esto no es json valido ',
      authHeaders,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('INVALID_JSON');
  });

  it('lista expediciones y consulta el detalle completo (cabecera + extra + lineas)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expedicionesAza' && body.propietario === 'AZA') {
          return { status: 200, body: [{ id: '1234', pedido: 'PED-0001', estado: 'PENDIENTE' }] };
        }
        if (proc === 'p_expedicionesAza' && body.pedido === 'PED-0001') {
          return {
            status: 200,
            body: [{ id: '1234', pedido: 'PED-0001', estado: 'PENDIENTE', transportista: 'SEUR', ruta: 'RT001', prioridad: '0' }],
          };
        }
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234', pedido: 'PED-0001' }] };
        }
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_INICIO') {
          return { status: 200, body: [{ carga: 'C1' }] };
        }
        if (proc === 'p_expPedidoLineas' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '55010', referencia: 'REF-100' }] };
        }
        if (proc === 'p_expPedidoContenedores' && body.accion === 'SELECT_INICIO') {
          return { status: 200, body: [{ id: '296821', contenedor: 'C03001', hu: 'WH0004731', referencia: 'REF-100', cantidad: '1.0000' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const listado = await httpJson(appUrl, 'GET', '/api/expediciones?propietario=AZA', undefined, authHeaders);
    expect(listado.status).toBe(200);
    expect(listado.body).toHaveLength(1);

    const detalle = await httpJson(appUrl, 'GET', '/api/expediciones/1234', undefined, authHeaders);
    expect(detalle.status).toBe(200);
    expect(detalle.body.cabecera.idPedido).toBe('1234');
    expect(detalle.body.datosExtra.carga).toBe('C1');
    expect(detalle.body.lineas).toHaveLength(1);
    expect(detalle.body.contenedores).toHaveLength(1);
    expect(detalle.body.contenedores[0].contenedor).toBe('C03001');
    expect(detalle.body.resumenListado.transportista).toBe('SEUR');
    expect(detalle.body.resumenListado.ruta).toBe('RT001');
  });

  it('la cabecera Almacen de la peticion se reenvia a LUX; sin ella se usa el almacen por defecto', async () => {
    mock.updateOptions({ onProc: () => ({ status: 200, body: [{ id: '1', pedido: 'P', estado: 'X' }] }) });

    await httpJson(appUrl, 'GET', '/api/expediciones', undefined, authHeaders);
    let call = mock.callLog.filter((c) => c.path.startsWith('/proc/')).at(-1);
    expect(call?.headers.almacen).toBe('ALM01'); // ver tests/mocks/testConfig.ts

    await httpJson(appUrl, 'GET', '/api/expediciones', undefined, { ...authHeaders, Almacen: 'CHESTE' });
    call = mock.callLog.filter((c) => c.path.startsWith('/proc/')).at(-1);
    expect(call?.headers.almacen).toBe('CHESTE');
  });

  it('rechaza un almacen desconocido en la cabecera Almacen sin llegar a llamar a LUX', async () => {
    const antes = mock.callLog.filter((c) => c.path.startsWith('/proc/')).length;

    const response = await httpJson(appUrl, 'GET', '/api/expediciones', undefined, {
      ...authHeaders,
      Almacen: 'ALMACEN_INVENTADO',
    });

    expect(response.status).toBe(400);
    const despues = mock.callLog.filter((c) => c.path.startsWith('/proc/')).length;
    expect(despues).toBe(antes);
  });

  it('GET /api/expediciones/datos-extra?propietario=X devuelve la plantilla de datos extra sin necesitar idPedido', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_INICIO' && body.propietario === '00180107') {
          return { status: 200, body: [{ generarDeca: '', serviceLevel: '', carga: '' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const response = await httpJson(appUrl, 'GET', '/api/expediciones/datos-extra?propietario=00180107', undefined, authHeaders);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ generarDeca: '', serviceLevel: '', carga: '' });
  });

  it('GET /api/expediciones/datos-extra sin propietario devuelve 400 sin llegar a llamar a LUX', async () => {
    const antes = mock.callLog.filter((c) => c.path.startsWith('/proc/')).length;

    const response = await httpJson(appUrl, 'GET', '/api/expediciones/datos-extra', undefined, authHeaders);

    expect(response.status).toBe(400);
    const despues = mock.callLog.filter((c) => c.path.startsWith('/proc/')).length;
    expect(despues).toBe(antes);
  });

  it('"/datos-extra" no se confunde con un idPedido en GET /api/expediciones/:idPedido', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_INICIO') {
          return { status: 200, body: [{ carga: 'C1' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const response = await httpJson(appUrl, 'GET', '/api/expediciones/datos-extra?propietario=X', undefined, authHeaders);

    // Si "datos-extra" se hubiera colado como :idPedido, habria intentado un SELECT_ONE con
    // idPedido="datos-extra" en vez de llamar a la ruta dedicada -- confirmamos que no paso.
    const llamoSelectOne = mock.callLog.some(
      (c) => c.path.startsWith('/proc/p_expCabeceraAza') && (c.body as Record<string, unknown>)?.accion === 'SELECT_ONE',
    );
    expect(llamoSelectOne).toBe(false);
    expect(response.status).toBe(200);
  });
});
