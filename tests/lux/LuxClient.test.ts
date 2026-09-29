import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth';
import { LuxClient } from '../../src/lux/client';
import { createLogger } from '../../src/logging';
import { LuxFunctionalError, LuxHttpError, LuxNetworkError, LuxValidationError } from '../../src/lux/errors';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

describe('LuxClient', () => {
  let mock: LuxMockServer;
  let baseUrl: string;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
  });

  afterEach(async () => {
    await mock.close();
  });

  function buildClient(overrides: Parameters<typeof buildTestConfig>[0] = {}, retries = 2, delay = 5) {
    const config = buildTestConfig({ luxBaseUrl: baseUrl, ...overrides });
    const auth = new AuthManager(config, createLogger('error'));
    const client = new LuxClient(config, auth, createLogger('error'), undefined, retries, delay);
    return { client, auth, config };
  }

  it('rechaza localmente un procedimiento fuera de whitelist sin llamar a LUX (403 local)', async () => {
    const { client } = buildClient();
    await expect(client.callProc('p_otroProcedimiento', 'SELECT', {})).rejects.toBeInstanceOf(
      LuxValidationError,
    );
    const procCalls = mock.callLog.filter((c) => c.path.startsWith('/proc/'));
    expect(procCalls).toHaveLength(0);
  });

  it('rechaza localmente un procedimiento sin prefijo p_', async () => {
    const { client } = buildClient();
    await expect(client.callProc('exec_x', 'SELECT', {})).rejects.toBeInstanceOf(LuxValidationError);
  });

  it('acepta un procedimiento valido de la whitelist y ejecuta la llamada', async () => {
    mock.updateOptions({ onProc: () => ({ status: 200, body: [{ mensaje: 'OK', idPedido: '1' }] }) });
    const { client } = buildClient();
    const result = await client.callProc('p_expCabeceraAza', 'ACTUALIZAR', { idPedido: '0' });
    expect(result).toEqual([{ mensaje: 'OK', idPedido: '1' }]);
  });

  it('usa el almacen de la configuracion por defecto si no se indica uno en la llamada', async () => {
    const { client } = buildClient({ luxWarehouse: 'ALM01' });
    mock.updateOptions({ onProc: () => ({ status: 200, body: [{ mensaje: 'OK' }] }) });
    await client.callProc('p_expedicionesAza', 'SELECT', {});
    const call = mock.callLog.find((c) => c.path.startsWith('/proc/'));
    expect(call?.headers.almacen).toBe('ALM01');
  });

  it('el almacen indicado en options.almacen sobreescribe al de la configuracion por defecto', async () => {
    const { client } = buildClient({ luxWarehouse: 'ALM01' });
    mock.updateOptions({ onProc: () => ({ status: 200, body: [{ mensaje: 'OK' }] }) });
    await client.callProc('p_expedicionesAza', 'SELECT', {}, { almacen: 'CHESTE' });
    const call = mock.callLog.find((c) => c.path.startsWith('/proc/'));
    expect(call?.headers.almacen).toBe('CHESTE');
  });

  it('funciona con body vacio (solo accion)', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body).toEqual({ accion: 'SELECT_CARGAS' });
        return { status: 200, body: [{ mensaje: 'OK' }] };
      },
    });
    const { client } = buildClient();
    await client.callProc('p_expCabeceraAza', 'SELECT_CARGAS', {});
  });

  it('envia los headers Authorization, Almacen y Content-Type correctos', async () => {
    mock.updateOptions({ onProc: () => ({ status: 200, body: [{ mensaje: 'OK' }] }) });
    const { client } = buildClient({ luxWarehouse: 'ALM99' });
    await client.callProc('p_expCabeceraAza', 'SELECT_ONE', { idPedido: '1' });

    const call = mock.callLog.find((c) => c.path.startsWith('/proc/'));
    expect(call).toBeDefined();
    expect(call!.headers.authorization).toMatch(/^Bearer .+/);
    expect(call!.headers.almacen).toBe('ALM99');
    expect(call!.headers['content-type']).toContain('application/json');
  });

  it('nunca envia usuario ni almacen en el body, aunque el llamador los incluya por error', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body).not.toHaveProperty('usuario');
        expect(body).not.toHaveProperty('almacen');
        expect(body).toMatchObject({ accion: 'ACTUALIZAR', idPedido: '0' });
        return { status: 200, body: [{ mensaje: 'OK' }] };
      },
    });
    const { client } = buildClient();
    // Nota: ProcRequest es Record<string,string>, por lo que el compilador permite estas claves;
    // la proteccion real ocurre en tiempo de ejecucion dentro de LuxClient.callProc (delete body.usuario/almacen).
    await client.callProc('p_expCabeceraAza', 'ACTUALIZAR', {
      idPedido: '0',
      usuario: 'no-deberia-llegar',
      almacen: 'no-deberia-llegar',
    });
  });

  it('interpreta mensaje !== "OK" como LuxFunctionalError con campo y tab', async () => {
    mock.updateOptions({
      onProc: () => ({
        status: 200,
        body: [{ mensaje: 'ERR_TRANSPORTISTA_NOT_EXISTS', campo: 'TRANSPORTISTA', tab: 'GENERAL' }],
      }),
    });
    const { client } = buildClient();
    const error = await client
      .callProc('p_expCabeceraAza', 'ACTUALIZAR', { idPedido: '0' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(LuxFunctionalError);
    expect(error.mensaje).toBe('ERR_TRANSPORTISTA_NOT_EXISTS');
    expect(error.campo).toBe('TRANSPORTISTA');
  });

  it('traduce un HTTP 400 en LuxHttpError sin reintentar', async () => {
    let calls = 0;
    mock.updateOptions({
      onProc: () => {
        calls += 1;
        return { status: 400, body: { mensaje: 'Bad request' } };
      },
    });
    const { client } = buildClient();
    await expect(client.callProc('p_expedicionesAza', 'SELECT', {})).rejects.toBeInstanceOf(LuxHttpError);
    expect(calls).toBe(1);
  });

  it('reintenta en 5xx para acciones de lectura y termina en exito', async () => {
    let calls = 0;
    mock.updateOptions({
      onProc: () => {
        calls += 1;
        if (calls < 3) {
          return { status: 500, body: { mensaje: 'Internal error' } };
        }
        return { status: 200, body: [{ mensaje: 'OK' }] };
      },
    });
    const { client } = buildClient();
    const result = await client.callProc('p_expedicionesAza', 'SELECT', {});
    expect(result).toEqual([{ mensaje: 'OK' }]);
    expect(calls).toBe(3);
  });

  it('NUNCA reintenta automaticamente una accion de escritura (ACTUALIZAR/INSERT/UPDATE) en 5xx', async () => {
    let calls = 0;
    mock.updateOptions({
      onProc: () => {
        calls += 1;
        return { status: 500, body: { mensaje: 'Internal error' } };
      },
    });
    const { client } = buildClient();
    await expect(client.callProc('p_expCabeceraAza', 'ACTUALIZAR', { idPedido: '0' })).rejects.toBeInstanceOf(
      LuxHttpError,
    );
    expect(calls).toBe(1);
  });

  it('reintenta en error de red (timeout) para lecturas', async () => {
    let calls = 0;
    mock.updateOptions({
      onProc: () => {
        calls += 1;
        if (calls < 2) {
          return 'timeout';
        }
        return { status: 200, body: [{ mensaje: 'OK' }] };
      },
    });
    const { client } = buildClient({ luxTimeoutMs: 100 });
    const result = await client.callProc('p_expedicionesAza', 'SELECT', {});
    expect(result).toEqual([{ mensaje: 'OK' }]);
    expect(calls).toBe(2);
  }, 10000);

  it('nunca reintenta un error funcional', async () => {
    let calls = 0;
    mock.updateOptions({
      onProc: () => {
        calls += 1;
        return { status: 200, body: [{ mensaje: 'ERR_ALGO' }] };
      },
    });
    const { client } = buildClient();
    await expect(client.callProc('p_expedicionesAza', 'SELECT', {})).rejects.toBeInstanceOf(
      LuxFunctionalError,
    );
    expect(calls).toBe(1);
  });

  it('nunca reintenta un 401/403', async () => {
    let calls = 0;
    mock.updateOptions({
      onProc: () => {
        calls += 1;
        return { status: 403, body: { mensaje: 'Forbidden' } };
      },
    });
    const { client } = buildClient();
    await expect(client.callProc('p_expedicionesAza', 'SELECT', {})).rejects.toBeInstanceOf(LuxHttpError);
    expect(calls).toBe(1);
  });

  it('un error de red puro se traduce a LuxNetworkError', async () => {
    const { client } = buildClient({ luxBaseUrl: 'http://127.0.0.1:1' }, 0);
    await expect(client.callProc('p_expedicionesAza', 'SELECT', {})).rejects.toBeInstanceOf(
      LuxNetworkError,
    );
  });
});
