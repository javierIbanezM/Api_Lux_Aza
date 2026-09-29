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

describe('Integracion: flujo completo de alta de recepcion', () => {
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

  it('crea una recepcion con lineas end-to-end via la API propia de AZA', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'ACTUALIZAR') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012', albaran: 'ALB-77' }] };
        }
        if (proc === 'p_recAlbaranLineas' && body.accion === 'INSERT') {
          return { status: 200, body: [{ mensaje: 'OK', id: '88010' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/recepciones',
      {
        propietario: 'AZA',
        codProveedor: 'PROV1',
        lineas: [{ referencia: 'REF-100', piezasAlbaran: '50' }],
      },
      authHeaders,
    );

    expect(response.status).toBe(201);
    expect(response.body.idAlbaran).toBe('3012');
    expect(response.body.lineas.ok).toHaveLength(1);
    expect(response.body.lineas.fallidas).toHaveLength(0);
  });

  it('devuelve 422 y no crea lineas cuando la cabecera de recepcion falla', async () => {
    let lineaCalls = 0;
    mock.updateOptions({
      onProc: (proc) => {
        if (proc === 'p_recCabeceraAza') {
          return { status: 200, body: [{ mensaje: 'ERR_PROVEEDOR_NOT_EXISTS' }] };
        }
        lineaCalls += 1;
        return { status: 200, body: [{ mensaje: 'OK' }] };
      },
    });

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/recepciones',
      {
        propietario: 'AZA',
        codProveedor: 'NO_EXISTE',
        lineas: [{ referencia: 'REF-100', piezasAlbaran: '50' }],
      },
      authHeaders,
    );

    expect(response.status).toBe(422);
    expect(lineaCalls).toBe(0);
  });

  it('devuelve 401 si no se envia la cabecera X-Api-Key', async () => {
    const response = await httpJson(appUrl, 'POST', '/api/recepciones', {
      propietario: 'AZA',
      codProveedor: 'PROV1',
    });

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('UNAUTHORIZED');
  });

  it('devuelve 401 si la cabecera X-Api-Key es incorrecta', async () => {
    const response = await httpJson(
      appUrl,
      'GET',
      '/api/recepciones',
      undefined,
      { 'X-Api-Key': 'clave-incorrecta' },
    );

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('UNAUTHORIZED');
  });

  it('devuelve 400 (sin llamar a LUX) cuando el array de lineas supera el limite de 200', async () => {
    let cabeceraCalls = 0;
    mock.updateOptions({
      onProc: () => {
        cabeceraCalls += 1;
        return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012', albaran: 'ALB-77' }] };
      },
    });

    const lineas = Array.from({ length: 201 }, (_, i) => ({
      referencia: `REF-${i}`,
      piezasAlbaran: '1',
    }));

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/recepciones',
      { propietario: 'AZA', codProveedor: 'PROV1', lineas },
      authHeaders,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('VALIDATION_ERROR');
    expect(cabeceraCalls).toBe(0);
  });

  it('devuelve 400 (no 500) cuando el body no es JSON valido', async () => {
    const response = await httpRaw(
      appUrl,
      'POST',
      '/api/recepciones',
      '{ esto no es json valido ',
      authHeaders,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('INVALID_JSON');
  });

  it('consulta el detalle completo de una recepcion (cabecera + extra + lineas)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012', albaran: 'ALB-77', propietario: 'CAMELIA' }] };
        }
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_INICIO') {
          return { status: 200, body: [{ matricula: '1234ABC' }] };
        }
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_DESCARGAS') {
          expect(body.propietario).toBe('CAMELIA');
          return { status: 200, body: [{ descarga: 'MUELLE1' }] };
        }
        if (proc === 'p_recAlbaranLineas' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '88010', referencia: 'REF-100' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const detalle = await httpJson(appUrl, 'GET', '/api/recepciones/3012', undefined, authHeaders);
    expect(detalle.status).toBe(200);
    expect(detalle.body.cabecera.idAlbaran).toBe('3012');
    expect(detalle.body.datosExtra.matricula).toBe('1234ABC');
    expect(detalle.body.lineas).toHaveLength(1);
    expect(detalle.body.descargas).toEqual([{ descarga: 'MUELLE1' }]);
  });

  it('propaga un error de red de LUX como 503', async () => {
    await mock.close(); // simula LUX caido

    const response = await httpJson(
      appUrl,
      'POST',
      '/api/recepciones',
      { propietario: 'AZA', codProveedor: 'PROV1' },
      authHeaders,
    );

    expect(response.status).toBe(503);
    expect(response.body.error.type).toBe('LUX_NETWORK_ERROR');
  });
});
