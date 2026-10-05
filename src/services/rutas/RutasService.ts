import type { LuxClient } from '../../lux/client';
import type { LlamadaApi, RutaDeca, RutaDecaEnvio } from '../../lux/models';
import type { ExpedicionesService } from '../expediciones';

/** Como se llego al nombre exacto de la ruta a partir del filtro del log. */
export type MetodoResolucion = 'listado' | 'listado-enviado' | 'filtro-literal';

/** Resolucion del filtro de ruta: nombres exactos + las llamadas que hicieron falta. */
export interface ResolucionRuta {
  numerosRuta: string[];
  metodo: MetodoResolucion;
  llamadas: LlamadaApi[];
}

/** Resultado de consultar el DECA de una ruta concreta (nombre exacto de la ruta). */
export interface RutaDecaConsulta {
  numeroRuta: string;
  deca: RutaDeca[];
  envios: RutaDecaEnvio[];
  /** La consulta hecha a la API para obtener estos datos (para dejarla junto a ellos). */
  consulta: {
    filtroLog: string;
    metodoResolucion: MetodoResolucion;
    llamadas: LlamadaApi[];
  };
}

/** Quita comodines y espacios sobrantes de un filtro de ruta ('%RT0001_2026_X %' -> 'RT0001_2026_X'). */
export function limpiarFiltroRuta(filtro: string): string {
  return filtro.replace(/%/g, '').trim();
}

/** LUX devuelve cuerpo vacio ("") en vez de [] cuando no hay filas en algunas acciones. */
function comoFilas<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Rutas de transporte: DECA (p_expRutasDeca). `numeroRuta` debe ser EXACTO, pero el filtro que el
 * usuario escribe en la pantalla de expediciones suele ser parcial y con comodines
 * (`%RT00013615_2026_COMP %`); `resolverNumerosRuta` obtiene el nombre exacto a partir del propio
 * listado de expediciones, que si admite ese filtro y devuelve el campo `ruta` completo.
 */
export class RutasService {
  constructor(
    private readonly luxClient: LuxClient,
    private readonly expedicionesService: ExpedicionesService,
  ) {}

  /** DECA de una ruta (p_expRutasDeca, accion=SELECT) por `numeroRuta` exacto. */
  async obtenerDeca(numeroRuta: string, almacen?: string): Promise<RutaDeca[]> {
    const rows = await this.luxClient.callProc('p_expRutasDeca', 'SELECT', { numeroRuta }, {
      operacion: 'rutas.obtenerDeca',
      almacen,
    });
    return comoFilas<RutaDeca>(rows);
  }

  /** Eventos/envios de una ruta (p_expRutasDeca, accion=SELECT_ENVIOS) por `numeroRuta` exacto. */
  async obtenerEnvios(numeroRuta: string, almacen?: string): Promise<RutaDecaEnvio[]> {
    const rows = await this.luxClient.callProc('p_expRutasDeca', 'SELECT_ENVIOS', { numeroRuta }, {
      operacion: 'rutas.obtenerEnvios',
      almacen,
    });
    return comoFilas<RutaDecaEnvio>(rows);
  }

  /**
   * Nombres EXACTOS de ruta que corresponden a un filtro (posiblemente parcial y con %).
   * 1) listado de expediciones con ese filtro de ruta -> valores distintos del campo `ruta`;
   * 2) si no hay (el listado por defecto oculta los ENVIADO), lo mismo con estado=ENVIADO;
   * 3) si sigue sin haber, se prueba el propio filtro limpio por si ya era el nombre completo.
   */
  async resolverNumerosRuta(filtro: string, almacen?: string): Promise<string[]> {
    return (await this.resolver(filtro, almacen)).numerosRuta;
  }

  /** Igual que `resolverNumerosRuta`, pero devolviendo tambien el metodo y las llamadas hechas. */
  async resolver(filtro: string, almacen?: string): Promise<ResolucionRuta> {
    const limpio = limpiarFiltroRuta(filtro);
    const llamadas: LlamadaApi[] = [];
    const listar = async (parametros: Record<string, string>): Promise<Array<Record<string, string>>> => {
      const rows = (await this.expedicionesService.listarExpediciones(parametros, almacen)) as Array<Record<string, string>>;
      llamadas.push({ procedimiento: 'p_expedicionesAza', accion: 'SELECT', parametros, almacen, filas: rows.length });
      return rows;
    };
    const desde = (rows: Array<Record<string, string>>): string[] => [
      ...new Set(
        rows
          .map((r) => (r.ruta ?? '').trim())
          .filter((r) => r !== '' && r.toUpperCase() !== 'NO ASIGNADA'),
      ),
    ];

    const sinEstado = desde(await listar({ ruta: filtro }));
    if (sinEstado.length > 0) {
      return { numerosRuta: sinEstado, metodo: 'listado', llamadas };
    }
    const enviados = desde(await listar({ ruta: filtro, estado: 'ENVIADO' }));
    if (enviados.length > 0) {
      return { numerosRuta: enviados, metodo: 'listado-enviado', llamadas };
    }
    return { numerosRuta: limpio === '' ? [] : [limpio], metodo: 'filtro-literal', llamadas };
  }

  /** Resuelve el filtro y consulta SELECT + SELECT_ENVIOS de cada ruta resultante. */
  async consultarDeca(filtro: string, almacen?: string): Promise<RutaDecaConsulta[]> {
    const resolucion = await this.resolver(filtro, almacen);
    const resultados: RutaDecaConsulta[] = [];
    for (const numeroRuta of resolucion.numerosRuta) {
      const [deca, envios] = await Promise.all([
        this.obtenerDeca(numeroRuta, almacen),
        this.obtenerEnvios(numeroRuta, almacen),
      ]);
      resultados.push({
        numeroRuta,
        deca,
        envios,
        consulta: {
          filtroLog: filtro,
          metodoResolucion: resolucion.metodo,
          llamadas: [
            ...resolucion.llamadas,
            { procedimiento: 'p_expRutasDeca', accion: 'SELECT', parametros: { numeroRuta }, almacen, filas: deca.length },
            { procedimiento: 'p_expRutasDeca', accion: 'SELECT_ENVIOS', parametros: { numeroRuta }, almacen, filas: envios.length },
          ],
        },
      });
    }
    return resultados;
  }
}
