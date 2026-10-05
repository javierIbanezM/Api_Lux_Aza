import { describe, expect, it, vi } from 'vitest';
import { RutasService, limpiarFiltroRuta } from '../../src/services/rutas';
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

  it('cada resultado lleva la consulta hecha a la API: resolucion + SELECT + SELECT_ENVIOS con sus parametros y filas', async () => {
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
        { procedimiento: 'p_expRutasDeca', accion: 'SELECT_ENVIOS', parametros: { numeroRuta: 'RT1_B' }, almacen: 'SAGUNTO', filas: 0 },
      ],
    });
  });
});
