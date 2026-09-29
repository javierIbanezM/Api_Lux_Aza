import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth';
import { LuxClient } from '../../src/lux/client';
import { createLogger } from '../../src/logging';
import { ExpedicionesService } from '../../src/services/expediciones';
import { LuxFunctionalError, LuxValidationError } from '../../src/lux/errors';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

describe('ExpedicionesService', () => {
  let mock: LuxMockServer;
  let baseUrl: string;
  let service: ExpedicionesService;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
    const config = buildTestConfig({ luxBaseUrl: baseUrl });
    const auth = new AuthManager(config, createLogger('error'));
    const client = new LuxClient(config, auth, createLogger('error'));
    service = new ExpedicionesService(client);
  });

  afterEach(async () => {
    await mock.close();
  });

  it('crearExpedicion crea cabecera con idPedido "0" y accion ACTUALIZAR', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza') {
          expect(body.accion).toBe('ACTUALIZAR');
          expect(body.idPedido).toBe('0');
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234', pedido: 'PED-0001' }] };
        }
        return { status: 200, body: [{ mensaje: 'OK', id: '1' }] };
      },
    });

    const result = await service.crearExpedicion({
      propietario: 'AZA',
      codCliente: 'C001',
      transportista: 'SEUR',
      serviceLevel: '24H',
    });

    expect(result.idPedido).toBe('1234');
    expect(result.pedido).toBe('PED-0001');
    expect(result.lineas.ok).toHaveLength(0);
    expect(result.lineas.fallidas).toHaveLength(0);
  });

  it('crearExpedicion NUNCA crea lineas si la cabecera falla', async () => {
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
        return { status: 200, body: [{ mensaje: 'OK', id: '1' }] };
      },
    });

    await expect(
      service.crearExpedicion({
        propietario: 'AZA',
        codCliente: 'C001',
        transportista: 'NO_EXISTE',
        serviceLevel: '24H',
        lineas: [{ referencia: 'REF-100', cantidadPedida: '24' }],
      }),
    ).rejects.toBeInstanceOf(LuxFunctionalError);

    expect(lineaCalls).toBe(0);
  });

  it('crearExpedicion reporta lineas OK y fallidas por separado', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234', pedido: 'PED-0001' }] };
        }
        if (body.referencia === 'REF-BAD') {
          return { status: 200, body: [{ mensaje: 'ERR_REFERENCIA_NOT_EXISTS' }] };
        }
        return { status: 200, body: [{ mensaje: 'OK', id: '55010' }] };
      },
    });

    const result = await service.crearExpedicion({
      propietario: 'AZA',
      codCliente: 'C001',
      transportista: 'SEUR',
      serviceLevel: '24H',
      lineas: [
        { referencia: 'REF-100', cantidadPedida: '24' },
        { referencia: 'REF-BAD', cantidadPedida: '5' },
      ],
    });

    expect(result.lineas.ok).toHaveLength(1);
    expect(result.lineas.fallidas).toHaveLength(1);
    expect(result.lineas.fallidas[0]!.input.referencia).toBe('REF-BAD');
  });

  it('crearExpedicion no lanza si una linea es invalida: la cabecera se crea, la linea invalida va a fallidas y no bloquea a las demas', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234', pedido: 'PED-0001' }] };
        }
        // Solo deberia llegar aqui la linea valida.
        expect(body.referencia).toBe('REF-100');
        return { status: 200, body: [{ mensaje: 'OK', id: '55010' }] };
      },
    });

    const result = await service.crearExpedicion({
      propietario: 'AZA',
      codCliente: 'C001',
      transportista: 'SEUR',
      serviceLevel: '24H',
      lineas: [
        { referencia: 'REF-100', cantidadPedida: '24' },
        { cantidadPedida: '5' }, // falta "referencia" (obligatoria) -> invalida
      ],
    });

    // La cabecera, ya creada en LUX, nunca se pierde por culpa de una linea mal formada.
    expect(result.idPedido).toBe('1234');
    expect(result.cabecera.idPedido).toBe('1234');

    // La linea valida se procesa con normalidad...
    expect(result.lineas.ok).toHaveLength(1);
    // ...y la invalida se reporta en fallidas, sin lanzar ni abortar el metodo.
    expect(result.lineas.fallidas).toHaveLength(1);
    expect(result.lineas.fallidas[0]!.input).toEqual({ cantidadPedida: '5' });
    expect(result.lineas.fallidas[0]!.error).toBeTruthy();
  });

  it('actualizarExpedicion solo envia los campos que cambian (semantica datos extra)', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body).toEqual({
          accion: 'ACTUALIZAR',
          idPedido: '1234',
          transportista: 'DHL',
        });
        return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234' }] };
      },
    });

    await service.actualizarExpedicion({ idPedido: '1234', transportista: 'DHL' });
  });

  it('actualizarExpedicion valida que idPedido tenga formato numerico', async () => {
    await expect(
      service.actualizarExpedicion({ idPedido: 'abc', transportista: 'DHL' } as never),
    ).rejects.toBeInstanceOf(LuxValidationError);
  });

  it('crearLineaExpedicion envia accion INSERT', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body.accion).toBe('INSERT');
        expect(body.pedido).toBe('PED-0001');
        return { status: 200, body: [{ mensaje: 'OK', id: '55010' }] };
      },
    });
    const result = await service.crearLineaExpedicion({
      pedido: 'PED-0001',
      referencia: 'REF-100',
      cantidadPedida: '24',
    });
    expect(result.id).toBe('55010');
  });

  it('actualizarLineaExpedicion envia accion UPDATE con el id', async () => {
    mock.updateOptions({
      onProc: (_proc, body) => {
        expect(body.accion).toBe('UPDATE');
        expect(body.id).toBe('55010');
        expect(body.cantidadPedida).toBe('30');
        return { status: 200, body: [{ mensaje: 'OK', id: '55010' }] };
      },
    });
    await service.actualizarLineaExpedicion({ id: '55010', cantidadPedida: '30' });
  });

  it('listarExpediciones envia los filtros y accion SELECT', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expedicionesAza');
        expect(body).toEqual({ accion: 'SELECT', propietario: 'AZA', pedido: 'PED-0001%' });
        return { status: 200, body: [{ id: '1', pedido: 'PED-0001' }] };
      },
    });
    const result = await service.listarExpediciones({ propietario: 'AZA', pedido: 'PED-0001%' });
    expect(result).toHaveLength(1);
  });

  it('obtenerExpedicion usa SELECT_ONE con idPedido', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expCabeceraAza');
        expect(body).toEqual({ accion: 'SELECT_ONE', idPedido: '1234' });
        return { status: 200, body: [{ mensaje: 'OK', idPedido: '1234' }] };
      },
    });
    const cabecera = await service.obtenerExpedicion('1234');
    expect(cabecera.idPedido).toBe('1234');
  });

  it('obtenerDatosExtraExpedicion usa SELECT_INICIO con idParent', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expCabeceraAza');
        expect(body).toEqual({ accion: 'SELECT_INICIO', idParent: '1234' });
        return { status: 200, body: [{ carga: 'C1' }] };
      },
    });
    const extra = await service.obtenerDatosExtraExpedicion('1234');
    expect(extra.carga).toBe('C1');
  });

  it('obtenerLineasExpedicion usa SELECT con idParent', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expPedidoLineas');
        expect(body).toEqual({ accion: 'SELECT', idParent: '1234' });
        return { status: 200, body: [{ id: '55010', referencia: 'REF-100' }] };
      },
    });
    const lineas = await service.obtenerLineasExpedicion('1234');
    expect(lineas).toHaveLength(1);
  });

  it('obtenerContenedoresExpedicion usa SELECT_INICIO con idParent sobre p_expPedidoContenedores', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expPedidoContenedores');
        expect(body).toEqual({ accion: 'SELECT_INICIO', idParent: '1234' });
        return {
          status: 200,
          body: [{ id: '296821', contenedor: 'C03001', hu: 'WH0004731', referencia: 'REF-100', cantidad: '1.0000' }],
        };
      },
    });
    const contenedores = await service.obtenerContenedoresExpedicion('1234');
    expect(contenedores).toHaveLength(1);
    expect(contenedores[0]!.contenedor).toBe('C03001');
  });

  it('obtenerResumenListadoExpedicion filtra p_expedicionesAza por pedido exacto (sin comodin)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        expect(proc).toBe('p_expedicionesAza');
        expect(body).toEqual({ accion: 'SELECT', pedido: 'PED-0001' });
        return {
          status: 200,
          body: [{ id: '1234', pedido: 'PED-0001', transportista: 'SEUR', ruta: 'RT001' }],
        };
      },
    });
    const resumen = await service.obtenerResumenListadoExpedicion('PED-0001');
    expect(resumen?.transportista).toBe('SEUR');
  });

  it('obtenerResumenListadoExpedicion no llama a LUX si el pedido viene vacio', async () => {
    mock.updateOptions({
      onProc: () => {
        throw new Error('No deberia llamar a LUX con pedido vacio');
      },
    });
    const resumen = await service.obtenerResumenListadoExpedicion('');
    expect(resumen).toBeUndefined();
  });
});
