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

  it('obtenerDetalle reune cabecera, datos extra, lineas, HUs y la fila del listado (los mismos datos que guarda el watcher)', async () => {
    const llamadas: string[] = [];
    mock.updateOptions({
      onProc: (proc, body) => {
        llamadas.push(`${proc}:${body.accion}`);
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '7', albaran: 'REC1', propietario: 'ROC' }] };
        }
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_INICIO') {
          return { status: 200, body: [{ matricula: '1234ABC', telefono: '' }] };
        }
        if (proc === 'p_recAlbaranLineas') {
          return { status: 200, body: [{ id: '1', referencia: 'R1' }] };
        }
        if (proc === 'p_recAlbaranHUPreinformado') {
          expect(body.idParent).toBe('7');
          return { status: 200, body: [{ id: '9', hu: 'H1', ubicacion: '' }, { id: '10', hu: 'H2', ubicacion: 'A-01' }] };
        }
        if (proc === 'p_recepcionesAza') {
          expect(body.albaran).toBe('REC1'); // el listado se pide con el texto del albaran de la cabecera
          return { status: 200, body: [{ id: '7', albaran: 'REC1', estado: 'CERRADO', fechaCierre: '' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const d = await service.obtenerDetalle('7', 'SAGUNTO');

    expect(d.cabecera.albaran).toBe('REC1');
    expect(d.datosExtra).toEqual({ matricula: '1234ABC', telefono: '' }); // los vacios se conservan
    expect(d.lineas).toHaveLength(1);
    expect(d.hus.map((h) => h.hu)).toEqual(['H1', 'H2']);
    expect(d.resumenListado).toMatchObject({ estado: 'CERRADO', fechaCierre: '' });
    expect(llamadas).toEqual(expect.arrayContaining(['p_recAlbaranHUPreinformado:SELECT_INICIO', 'p_recepcionesAza:SELECT']));
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
        if (body.estado === 'CERRADO') {
          return { status: 200, body: [] };
        }
        expect(body).toEqual({ accion: 'SELECT', propietario: 'AZA' });
        return { status: 200, body: [{ id: '3012', albaran: 'ALB-77' }] };
      },
    });
    const result = await service.listarRecepciones({ propietario: 'AZA' });
    expect(result).toHaveLength(1);
  });

  it('listarRecepciones sin filtro de estado hace una segunda llamada con estado=CERRADO y fusiona (LUX no las devuelve sin filtro)', async () => {
    const llamadas: Array<Record<string, string>> = [];
    mock.updateOptions({
      onProc: (proc, body) => {
        llamadas.push(body);
        if (body.estado === 'CERRADO') {
          return { status: 200, body: [{ id: '9001', albaran: 'ALB-CERRADA', estado: 'CERRADO' }] };
        }
        return { status: 200, body: [{ id: '3012', albaran: 'ALB-77', estado: 'CREACION' }] };
      },
    });

    const result = await service.listarRecepciones({});

    expect(llamadas).toHaveLength(2);
    expect(llamadas[0]).toEqual({ accion: 'SELECT' });
    expect(llamadas[1]).toEqual({ accion: 'SELECT', estado: 'CERRADO' });
    expect(result).toEqual([
      { id: '3012', albaran: 'ALB-77', estado: 'CREACION' },
      { id: '9001', albaran: 'ALB-CERRADA', estado: 'CERRADO' },
    ]);
  });

  it('listarRecepciones filtrando por un estado concreto NO hace la segunda llamada', async () => {
    let llamadas = 0;
    mock.updateOptions({
      onProc: (proc, body) => {
        llamadas += 1;
        expect(body).toEqual({ accion: 'SELECT', estado: 'DISCREPANCIA' });
        return { status: 200, body: [{ id: '5000', albaran: 'ALB-D', estado: 'DISCREPANCIA' }] };
      },
    });

    const result = await service.listarRecepciones({ estado: 'DISCREPANCIA' });

    expect(llamadas).toBe(1);
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

  it('obtenerDatosExtraRecepcionPorPropietario usa SELECT_INICIO con propietario (recepcion aun no creada)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recCabeceraAza');
        expect(body).toEqual({ accion: 'SELECT_INICIO', propietario: '00180107' });
        return { status: 200, body: [{ matricula: '', dni: '', bultosPrevistos: '' }] };
      },
    });
    const extra = await service.obtenerDatosExtraRecepcionPorPropietario('00180107');
    expect(extra).toEqual({ matricula: '', dni: '', bultosPrevistos: '' });
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

  it('obtenerResumenListadoRecepcion filtra p_recepcionesAza por albaran exacto (sin comodin)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_recepcionesAza');
        expect(body).toEqual({ accion: 'SELECT', albaran: 'REC0000067' });
        return { status: 200, body: [{ id: '7837', albaran: 'REC0000067', propietario: 'ROC', estado: 'CREACION' }] };
      },
    });
    const resumen = await service.obtenerResumenListadoRecepcion('REC0000067');
    expect(resumen?.estado).toBe('CREACION');
  });

  it('obtenerResumenListadoRecepcion no llama a LUX si el albaran viene vacio', async () => {
    mock.updateOptions({
      onProc: () => {
        throw new Error('No deberia llamar a LUX con albaran vacio');
      },
    });
    const resumen = await service.obtenerResumenListadoRecepcion('');
    expect(resumen).toBeUndefined();
  });
});
