import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth';
import { LuxClient } from '../../src/lux/client';
import { createLogger } from '../../src/logging';
import { CatalogosService } from '../../src/services/catalogos';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

describe('CatalogosService', () => {
  let mock: LuxMockServer;
  let baseUrl: string;
  let service: CatalogosService;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
    const config = buildTestConfig({ luxBaseUrl: baseUrl });
    const auth = new AuthManager(config, createLogger('error'));
    const client = new LuxClient(config, auth, createLogger('error'));
    service = new CatalogosService(client, 60_000);
  });

  afterEach(async () => {
    await mock.close();
  });

  it('selectDescargas envia el propietario como parametro cuando se indica', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recCabeceraAza');
        expect(body).toEqual({ accion: 'SELECT_DESCARGAS', propietario: '00180107' });
        return { status: 200, body: [{ descarga: 'MUELLE1' }] };
      },
    });
    const descargas = await service.selectDescargas('00180107');
    expect(descargas).toEqual([{ descarga: 'MUELLE1' }]);
  });

  it('selectDescargas no envia propietario si no se indica', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(body).toEqual({ accion: 'SELECT_DESCARGAS' });
        return { status: 200, body: [] };
      },
    });
    await service.selectDescargas();
  });

  it('selectDescargas cachea por separado segun el propietario', async () => {
    let llamadas = 0;
    mock.updateOptions({
      onProc: (_proc, body) => {
        llamadas += 1;
        return { status: 200, body: [{ descarga: body.propietario === 'A' ? 'MUELLE-A' : 'MUELLE-B' }] };
      },
    });

    const a1 = await service.selectDescargas('A');
    const b1 = await service.selectDescargas('B');
    const a2 = await service.selectDescargas('A'); // deberia venir de cache, no una 3a llamada

    expect(a1[0]!.descarga).toBe('MUELLE-A');
    expect(b1[0]!.descarga).toBe('MUELLE-B');
    expect(a2[0]!.descarga).toBe('MUELLE-A');
    expect(llamadas).toBe(2);
  });
});
