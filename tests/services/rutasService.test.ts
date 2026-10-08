import { describe, expect, it, vi } from 'vitest';
import { RutasService, limpiarFiltroRuta, numeroRutaDe } from '../../src/services/rutas';
import type { LuxClient } from '../../src/lux/client';
import type { ExpedicionesService } from '../../src/services/expediciones';

function crear(opts: {
  listar?: (filtros: Record<string, string>) => Array<Record<string, string>>;
  proc?: (proc: string, accion: string, params: Record<string, string>) => unknown;
}) {
  const callProc = vi.fn(async (proc: string, accion: string, params: Record<string, string>) =>
    opts.proc ? opts.proc(proc, accion, params) : [],
  );
  const listarExpediciones = vi.fn(async (filtros: Record<string, string>) => (opts.listar ? opts.listar(filtros) : []));
  const servicio = new RutasService(
    { callProc } as unknown as LuxClient,
    { listarExpediciones } as unknown as ExpedicionesService,
  );
  return { servicio, callProc, listarExpediciones };
}

describe('services/RutasService', () => {
  it('obtenerTotalesRuta suma numPalets y numContenedores de los pedidos de la ruta, solo los de ESA ruta exacta (`_` es comodin en LUX)', async () => {
    const { servicio, listarExpediciones } = crear({
      listar: () => [
        { id: '1', pedido: 'P1', propietario: 'A', estado: 'ASIGNADO', ruta: 'rt1_2026_x ', numPalets: '2', pallets: '', numContenedores: '2' },
        { id: '2', pedido: 'P2', propietario: 'B', estado: 'ASIGNADO', ruta: 'RT1_2026_X', numPalets: '4', pallets: '', numContenedores: '6' },
        { id: '3', pedido: 'P3', propietario: 'A', estado: 'ASIGNADO', ruta: 'RT1_2026_X', numPalets: '', pallets: '', numContenedores: '' }, // vacios: cuentan 0
        { id: '9', pedido: 'P9', propietario: 'C', estado: 'ASIGNADO', ruta: 'RT1-2026-X', numPalets: '9', pallets: '', numContenedores: '9' }, // otra ruta
      ],
    });

    const t = await servicio.obtenerTotalesRuta('RT1_2026_X', 'SAGUNTO');

    expect(t).toMatchObject({ pedidos: 3, pallets: 6, numContenedores: 8 });
    expect(t.detalle.map((d) => d.pedido).sort()).toEqual(['P1', 'P2', 'P3']);
    // Pedidos sin enviar: basta el listado normal, NO se pide el listado pesado de ENVIADO.
    expect(listarExpediciones).toHaveBeenCalledTimes(1);
    expect(listarExpediciones).toHaveBeenCalledWith({ ruta: 'RT1_2026_X' }, 'SAGUNTO');
  });

  it('obtenerTotalesRuta: si el listado normal no trae nada (ruta ya enviada) pide el de estado=ENVIADO', async () => {
    const { servicio, listarExpediciones } = crear({
      listar: (f) => (f.estado === 'ENVIADO' ? [{ id: '2', pedido: 'P2', propietario: 'B', estado: 'ENVIADO', ruta: 'RT1_2026_X', numPalets: '4', pallets: '', numContenedores: '6' }] : []),
    });
    const t = await servicio.obtenerTotalesRuta('RT1_2026_X', 'SAGUNTO');
    expect(t).toMatchObject({ pedidos: 1, pallets: 4, numContenedores: 6 });
    expect(listarExpediciones).toHaveBeenCalledWith({ ruta: 'RT1_2026_X' }, 'SAGUNTO');
    expect(listarExpediciones).toHaveBeenCalledWith({ ruta: 'RT1_2026_X', estado: 'ENVIADO' }, 'SAGUNTO');
  });

  it('los totales de una ruta se recuerdan unos minutos: la 2a consulta no vuelve a llamar a LUX', async () => {
    const { servicio, listarExpediciones } = crear({
      listar: () => [{ id: '1', pedido: 'P1', propietario: 'A', estado: 'ASIGNADO', ruta: 'RT1_2026_X', numPalets: '2', pallets: '', numContenedores: '2' }],
    });
    await servicio.obtenerTotalesRuta('RT1_2026_X', 'SAGUNTO');
    await servicio.obtenerTotalesRuta('rt1_2026_x', 'SAGUNTO'); // mismo almacen y ruta (sin distinguir mayusculas)
    expect(listarExpediciones).toHaveBeenCalledTimes(1);
    await servicio.obtenerTotalesRuta('RT1_2026_X', 'ALMUSSAFES'); // otro almacen: otra consulta
    expect(listarExpediciones).toHaveBeenCalledTimes(2);
  });

  it('una ruta sin pedidos da totales a 0 (no undefined): asi no se reconsulta eternamente', async () => {
    const { servicio } = crear({});
    expect(await servicio.obtenerTotalesRuta('RT0_2026_X')).toMatchObject({ pedidos: 0, pallets: 0, numContenedores: 0, detalle: [] });
  });

  it('consultarDeca incluye los totales de la ruta, y si fallan consultarDeca sigue funcionando (totales undefined)', async () => {
    let falla = false;
    const { servicio } = crear({
      listar: (f) => {
        if (falla && f.ruta === 'RT1_2026_X') {
          throw new Error('LUX caido'); // solo el listado de totales (nombre exacto); el de la resolucion lleva comodines
        }
        return [{ id: '1', pedido: 'P1', propietario: 'A', estado: 'ENVIADO', ruta: 'RT1_2026_X', numPalets: '3', numContenedores: '5' }];
      },
      proc: (_p, accion) => (accion === 'SELECT' ? [{ shipmentReference: 'RT1_2026_X-AZA', estado: 'ENVIADO', shipmentId: 'S' }] : []),
    });
    const [ok] = await servicio.consultarDeca('%RT1_2026_X%', 'SAGUNTO');
    expect(ok?.totales).toMatchObject({ pallets: 3, numContenedores: 5 });

    falla = true;
    const [sinTotales] = await servicio.consultarDeca('%RT1_2026_X%', 'ALMUSSAFES'); // otro almacen: no sale de la cache
    expect(sinTotales?.totales).toBeUndefined();
    expect(sinTotales?.deca).toHaveLength(1);
  });

  it('numeroRutaDe quita el sufijo -AZA / -PROP de la referencia del envio', () => {
    expect(numeroRutaDe('RT00013659_2026_COMPARTIDO-PROP', '1')).toBe('RT00013659_2026_COMPARTIDO');
    expect(numeroRutaDe('RT00013615_2026_COMP MAMENTRANS007 S.L. -AZA', '1')).toBe('RT00013615_2026_COMP MAMENTRANS007 S.L.');
    expect(numeroRutaDe(undefined, '14764')).toBe('ruta-id-14764');
  });

  it('consultarDecaPorId usa el id de la ruta (solo SELECT) y devuelve nombre, datos y la consulta hecha', async () => {
    const { servicio, callProc } = crear({
      proc: (_p, accion) => (accion === 'SELECT' ? [{ shipmentReference: 'RT1_2026_X-AZA', estado: 'ENVIADO' }] : []),
    });
    const r = await servicio.consultarDecaPorId('14764', 'SAGUNTO', 0);
    expect(r?.numeroRuta).toBe('RT1_2026_X');
    expect(r?.deca).toHaveLength(1);
    expect(r?.consulta).toMatchObject({ filtroLog: 'GENERAR_DECA id=14764', metodoResolucion: 'id-ruta' });
    expect(r?.consulta.llamadas.map((x) => [x.accion, x.parametros])).toEqual([['SELECT', { id: '14764' }]]);
    expect(callProc).not.toHaveBeenCalledWith('p_expRutasDeca', 'SELECT_ENVIOS', expect.anything(), expect.anything());
    expect(callProc).toHaveBeenCalledWith('p_expRutasDeca', 'SELECT', { id: '14764' }, expect.objectContaining({ almacen: 'SAGUNTO' }));
  });

  it('consultarDecaPorId reintenta si el DECA aun no existe (el log se escribe al EMPEZAR la accion) y lo encuentra', async () => {
    let llamadas = 0;
    const { servicio } = crear({
      proc: (_p, accion) => {
        if (accion === 'SELECT') {
          llamadas += 1;
          return llamadas < 3 ? '' : [{ shipmentReference: 'RT2-PROP', estado: 'ENVIADO' }]; // aparece al 3er intento
        }
        return '';
      },
    });
    const r = await servicio.consultarDecaPorId('1', 'SAGUNTO', 1, 2);
    expect(r?.numeroRuta).toBe('RT2');
    expect(llamadas).toBe(3);
  });

  it('consultarDecaPorId devuelve undefined si tras los reintentos sigue sin haber DECA', async () => {
    const { servicio } = crear({ proc: () => '' });
    await expect(servicio.consultarDecaPorId('1', 'SAGUNTO', 1, 1)).resolves.toBeUndefined();
  });

  it('limpiarFiltroRuta quita comodines y espacios', () => {
    expect(limpiarFiltroRuta('%RT00013615_2026_COMP %')).toBe('RT00013615_2026_COMP');
  });

  it('resuelve el nombre exacto de la ruta a partir del listado de expediciones (valores distintos de "ruta")', async () => {
    const { servicio, listarExpediciones } = crear({
      listar: () => [
        { ruta: 'RT00013615_2026_COMP MAMENTRANS007 S.L.' },
        { ruta: 'RT00013615_2026_COMP MAMENTRANS007 S.L.' },
        { ruta: 'NO ASIGNADA' },
        { ruta: '' },
      ],
    });
    await expect(servicio.resolverNumerosRuta('%RT00013615_2026_COMP %', 'SAGUNTO')).resolves.toEqual([
      'RT00013615_2026_COMP MAMENTRANS007 S.L.',
    ]);
    expect(listarExpediciones).toHaveBeenCalledTimes(1);
  });

  it('si el listado por defecto no la trae (todos ENVIADO) reintenta con estado=ENVIADO', async () => {
    const { servicio } = crear({
      listar: (f) => (f.estado === 'ENVIADO' ? [{ ruta: 'RT00013600_2026_X' }] : []),
    });
    await expect(servicio.resolverNumerosRuta('%RT00013600%', 'SAGUNTO')).resolves.toEqual(['RT00013600_2026_X']);
  });

  it('si ningun listado la trae, usa el propio filtro limpio como nombre exacto', async () => {
    const { servicio } = crear({});
    await expect(servicio.resolverNumerosRuta('%RT00013600_2026_X%', 'SAGUNTO')).resolves.toEqual(['RT00013600_2026_X']);
  });

  it('SELECT y SELECT_ENVIOS usan p_expRutasDeca con numeroRuta; un cuerpo vacio ("") se trata como sin filas', async () => {
    const { servicio, callProc } = crear({
      proc: (_p, accion) => (accion === 'SELECT' ? [{ shipmentReference: 'RT1-AZA', estado: 'ENVIADO' }] : ''),
    });
    const r = await servicio.obtenerDeca('RT1', 'SAGUNTO');
    const e = await servicio.obtenerEnvios('RT1', 'SAGUNTO');
    expect(r).toHaveLength(1);
    expect(e).toEqual([]);
    expect(callProc).toHaveBeenCalledWith('p_expRutasDeca', 'SELECT', { numeroRuta: 'RT1' }, expect.objectContaining({ almacen: 'SAGUNTO' }));
    expect(callProc).toHaveBeenCalledWith('p_expRutasDeca', 'SELECT_ENVIOS', { numeroRuta: 'RT1' }, expect.objectContaining({ almacen: 'SAGUNTO' }));
  });

  it('consultarDeca devuelve una entrada por ruta resuelta', async () => {
    const { servicio } = crear({
      listar: () => [{ ruta: 'RT1_A' }, { ruta: 'RT1_B' }],
      proc: (_p, accion, params) => (accion === 'SELECT' && params.numeroRuta === 'RT1_B' ? [{ estado: 'ENVIADO' }] : []),
    });
    const res = await servicio.consultarDeca('%RT1%', 'SAGUNTO');
    expect(res.map((r) => [r.numeroRuta, r.deca.length])).toEqual([['RT1_A', 0], ['RT1_B', 1]]);
  });

  it('cada resultado lleva la consulta hecha a la API: resolucion + SELECT con sus parametros y filas (sin SELECT_ENVIOS, que falla siempre en LUX)', async () => {
    const { servicio } = crear({
      listar: () => [{ ruta: 'RT1_B' }],
      proc: (_p, accion) => (accion === 'SELECT' ? [{ estado: 'ENVIADO' }] : []),
    });
    const [r] = await servicio.consultarDeca('%RT1%', 'SAGUNTO');
    expect(r?.consulta).toEqual({
      filtroLog: '%RT1%',
      metodoResolucion: 'listado',
      llamadas: [
        { procedimiento: 'p_expedicionesAza', accion: 'SELECT', parametros: { ruta: '%RT1%' }, almacen: 'SAGUNTO', filas: 1 },
        { procedimiento: 'p_expRutasDeca', accion: 'SELECT', parametros: { numeroRuta: 'RT1_B' }, almacen: 'SAGUNTO', filas: 1 },
      ],
    });
  });
});
