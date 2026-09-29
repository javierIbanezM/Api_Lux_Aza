import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth';
import { LuxClient } from '../../src/lux/client';
import { createLogger } from '../../src/logging';
import { RecepcionesService } from '../../src/services/recepciones';
import { LuxFunctionalError, LuxValidationError } from '../../src/lux/errors';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

describe('RecepcionesService', () => {
  let mock: LuxMockServer;
  let baseUrl: string;
  let service: RecepcionesService;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
    const config = buildTestConfig({ luxBaseUrl: baseUrl });
    const auth = new AuthManager(config, createLogger('error'));
    const client = new LuxClient(config, auth, createLogger('error'));
    service = new RecepcionesService(client);
  });

  afterEach(async () => {
    await mock.close();
  });

  it('crearRecepcion crea cabecera con idAlbaran "0" y accion ACTUALIZAR', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza') {
          expect(body.accion).toBe('ACTUALIZAR');
          expect(body.idAlbaran).toBe('0');
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012', albaran: 'ALB-77' }] };
        }
        return { status: 200, body: [{ mensaje: 'OK', id: '1' }] };
      },
    });

    const result = await service.crearRecepcion({ propietario: 'AZA', codProveedor: 'PROV1' });

    expect(result.idAlbaran).toBe('3012');
    expect(result.albaran).toBe('ALB-77');
  });

  it('crearRecepcion NUNCA crea lineas si la cabecera falla', async () => {
    let lineaCalls = 0;
    mock.updateOptions({
      onProc: (proc) => {
        if (proc === 'p_recCabeceraAza') {
          return { status: 200, body: [{ mensaje: 'ERR_PROVEEDOR_NOT_EXISTS' }] };
        }
        lineaCalls += 1;
        return { status: 200, body: [{ mensaje: 'OK', id: '1' }] };
      },
    });

    await expect(
      service.crearRecepcion({
        propietario: 'AZA',
        codProveedor: 'NO_EXISTE',
        lineas: [{ referencia: 'REF-100', piezasAlbaran: '50' }],
      }),
    ).rejects.toBeInstanceOf(LuxFunctionalError);

    expect(lineaCalls).toBe(0);
  });

  it('crearRecepcion reporta lineas OK y fallidas por separado', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012', albaran: 'ALB-77' }] };
        }
        if (body.referencia === 'REF-BAD') {
          return { status: 200, body: [{ mensaje: 'ERR_REFERENCIA_NOT_EXISTS' }] };
        }
        return { status: 200, body: [{ mensaje: 'OK', id: '88010' }] };
      },
    });

    const result = await service.crearRecepcion({
      propietario: 'AZA',
      codProveedor: 'PROV1',
      lineas: [
        { referencia: 'REF-100', piezasAlbaran: '50' },
        { referencia: 'REF-BAD', piezasAlbaran: '10' },
      ],
    });

    expect(result.lineas.ok).toHaveLength(1);
    expect(result.lineas.fallidas).toHaveLength(1);
  });

  it('crearRecepcion no lanza si una linea es invalida: la cabecera se crea, la linea invalida va a fallidas y no bloquea a las demas', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012', albaran: 'ALB-77' }] };
        }
        // Solo deberia llegar aqui la linea valida.
        expect(body.referencia).toBe('REF-100');
        return { status: 200, body: [{ mensaje: 'OK', id: '88010' }] };
      },
    });

    const result = await service.crearRecepcion({
      propietario: 'AZA',
      codProveedor: 'PROV1',
      lineas: [
        { referencia: 'REF-100', piezasAlbaran: '50' },
        { piezasAlbaran: '10' }, // falta "referencia" (obligatoria) -> invalida
      ],
    });

    // La cabecera, ya creada en LUX, nunca se pierde por culpa de una linea mal formada.
    expect(result.idAlbaran).toBe('3012');
    expect(result.cabecera.idAlbaran).toBe('3012');

    expect(result.lineas.ok).toHaveLength(1);
    expect(result.lineas.fallidas).toHaveLength(1);
    expect(result.lineas.fallidas[0]!.input).toEqual({ piezasAlbaran: '10' });
    expect(result.lineas.fallidas[0]!.error).toBeTruthy();
  });

  it('actualizarRecepcion solo envia los campos que cambian', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body).toEqual({ accion: 'ACTUALIZAR', idAlbaran: '3012', agencia: 'DHL' });
        return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012' }] };
      },
    });
    await service.actualizarRecepcion({ idAlbaran: '3012', agencia: 'DHL' });
  });

  it('actualizarRecepcion valida formato de idAlbaran', async () => {
    await expect(
      service.actualizarRecepcion({ idAlbaran: 'no-numero' } as never),
    ).rejects.toBeInstanceOf(LuxValidationError);
  });

  it('crearLineaRecepcion envia accion INSERT con idParent', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body.accion).toBe('INSERT');
        expect(body.idParent).toBe('3012');
        return { status: 200, body: [{ mensaje: 'OK', id: '88010' }] };
      },
    });
    const result = await service.crearLineaRecepcion({
      idParent: '3012',
      referencia: 'REF-100',
      piezasAlbaran: '50',
    });
    expect(result.id).toBe('88010');
  });

  it('actualizarLineaRecepcion envia accion UPDATE', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body.accion).toBe('UPDATE');
        expect(body.id).toBe('88010');
        expect(body.piezasAlbaran).toBe('60');
        return { status: 200, body: [{ mensaje: 'OK', id: '88010' }] };
      },
    });
    await service.actualizarLineaRecepcion({ id: '88010', piezasAlbaran: '60' });
  });

  it('listarRecepciones envia filtros y accion SELECT', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recepcionesAza');
        expect(body).toEqual({ accion: 'SELECT', propietario: 'AZA' });
        return { status: 200, body: [{ id: '3012', albaran: 'ALB-77' }] };
      },
    });
    const result = await service.listarRecepciones({ propietario: 'AZA' });
    expect(result).toHaveLength(1);
  });

  it('obtenerRecepcion usa SELECT_ONE con idAlbaran', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recCabeceraAza');
        expect(body).toEqual({ accion: 'SELECT_ONE', idAlbaran: '3012' });
        return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '3012' }] };
      },
    });
    const cabecera = await service.obtenerRecepcion('3012');
    expect(cabecera.idAlbaran).toBe('3012');
  });

  it('obtenerDatosExtraRecepcion usa SELECT_INICIO con idParent', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recCabeceraAza');
        expect(body).toEqual({ accion: 'SELECT_INICIO', idParent: '3012' });
        return { status: 200, body: [{ matricula: '1234ABC' }] };
      },
    });
    const extra = await service.obtenerDatosExtraRecepcion('3012');
    expect(extra.matricula).toBe('1234ABC');
  });

  it('obtenerLineasRecepcion usa SELECT con idParent', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recAlbaranLineas');
        expect(body).toEqual({ accion: 'SELECT', idParent: '3012' });
        return { status: 200, body: [{ id: '88010', referencia: 'REF-100' }] };
      },
    });
    const lineas = await service.obtenerLineasRecepcion('3012');
    expect(lineas).toHaveLength(1);
  });
});
