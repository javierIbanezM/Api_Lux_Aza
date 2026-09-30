import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth';
import { LuxClient } from '../../src/lux/client';
import { createLogger } from '../../src/logging';
import { resolverPedidosDeRuta } from '../../src/watcher/routeResolver';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

describe('watcher/routeResolver', () => {
  let mock: LuxMockServer;
  let baseUrl: string;
  let client: LuxClient;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
    const config = buildTestConfig({ luxBaseUrl: baseUrl });
    const auth = new AuthManager(config, createLogger('error'));
    client = new LuxClient(config, auth, createLogger('error'));
  });

  afterEach(async () => {
    await mock.close();
  });

  it('llama a p_expRutasDetalle con accion SELECT e idParent=<idRuta>, y devuelve los id de pedido', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expRutasDetalle');
        expect(body).toEqual({ accion: 'SELECT', idParent: '4487' });
        return {
          status: 200,
          body: [
            { id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU' },
            { id: '11200', pedido: 'EXP0000080', propietario: 'AZA LOGISTICS SLU' },
          ],
        };
      },
    });

    const ids = await resolverPedidosDeRuta(client, '4487');
    expect(ids.sort()).toEqual(['11115', '11200']);
  });

  it('ignora filas sin un id valido en vez de fallar', async () => {
    mock.updateOptions({
      onProc: () => ({ status: 200, body: [{ id: '', pedido: 'x' }, { pedido: 'sin-id' }, { id: '999' }] }),
    });

    const ids = await resolverPedidosDeRuta(client, '4487');
    expect(ids).toEqual(['999']);
  });

  it('devuelve un array vacio si la ruta no tiene pedidos', async () => {
    mock.updateOptions({ onProc: () => ({ status: 200, body: [] }) });
    const ids = await resolverPedidosDeRuta(client, '4487');
    expect(ids).toEqual([]);
  });
});
