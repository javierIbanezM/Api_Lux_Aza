import type { LuxClient } from '../../lux/client';
import type { LlamadaApi, RutaDeca, RutaDecaEnvio } from '../../lux/models';
import type { ExpedicionesService } from '../expediciones';

/** Como se llego al nombre exacto de la ruta a partir del filtro del log. */
export type MetodoResolucion = 'listado' | 'listado-enviado' | 'filtro-literal' | 'id-ruta';

/** Resolucion del filtro de ruta: nombres exactos + las llamadas que hicieron falta. */
export interface ResolucionRuta {
  numerosRuta: string[];
  metodo: MetodoResolucion;
  llamadas: LlamadaApi[];
}

/** Totales de lo que lleva una ruta: suma de los pedidos asignados (filas del listado de expediciones). */
export interface TotalesRuta {
  /** Pedidos de la ruta. */
  pedidos: number;
  /** Suma de `numPalets` de sus pedidos (la columna `pallets` del listado llega siempre vacia). */
  pallets: number;
  /** Suma de `numContenedores` de sus pedidos. */
  numContenedores: number;
  /** Aporte de cada pedido, para poder comprobar los totales. */
  detalle: Array<{ id: string; pedido: string; propietario: string; estado: string; pallets: number; numContenedores: number }>;
}

/** Resultado de consultar el DECA de una ruta concreta (nombre exacto de la ruta). */
export interface RutaDecaConsulta {
  numeroRuta: string;
  deca: RutaDeca[];
  envios: RutaDecaEnvio[];
  /** Totales de la ruta (pallets y contenedores). `undefined` si no se pudieron calcular (se reintenta). */
  totales?: TotalesRuta;
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

/** Nombre de la ruta a partir de la referencia del envio (`<ruta>-AZA` / `<ruta>-PROP`). */
export function numeroRutaDe(shipmentReference: string | undefined, idRuta: string): string {
  const nombre = (shipmentReference ?? '').replace(/-(AZA|PROP)$/i, '').trim();
  return nombre === '' ? `ruta-id-${idRuta}` : nombre;
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

  /**
   * Totales de pallets y contenedores de una ruta: suma sobre los pedidos que lleva (listado de expediciones
   * filtrado por la ruta). Se piden las dos vistas (sin estado y estado=ENVIADO, porque LUX oculta por defecto
   * los pedidos enviados) y se queda con las filas cuya ruta es EXACTAMENTE la pedida (el filtro de LUX admite
   * comodines y `_` coincide con cualquier caracter).
   */
  async obtenerTotalesRuta(numeroRuta: string, almacen?: string): Promise<TotalesRuta> {
    const nombre = numeroRuta.trim().toUpperCase();
    const filas = new Map<string, Record<string, string>>();
    for (const extra of [{}, { estado: 'ENVIADO' }] as Array<Record<string, string>>) {
      const rows = (await this.expedicionesService.listarExpediciones({ ruta: numeroRuta, ...extra }, almacen)) as Array<Record<string, string>>;
      for (const r of rows) {
        if ((r.ruta ?? '').trim().toUpperCase() === nombre) {
          filas.set(r.id ?? `${r.pedido}|${r.propietario}`, r);
        }
      }
    }
    const entero = (v: string | undefined): number => {
      const n = Number.parseInt((v ?? '').trim(), 10);
      return Number.isNaN(n) ? 0 : n;
    };
    const detalle = [...filas.values()].map((r) => ({
      id: r.id ?? '',
      pedido: r.pedido ?? '',
      propietario: r.propietario ?? '',
      estado: r.estado ?? '',
      pallets: entero(r.numPalets) || entero(r.pallets),
      numContenedores: entero(r.numContenedores),
    }));
    return {
      pedidos: detalle.length,
      pallets: detalle.reduce((a, d) => a + d.pallets, 0),
      numContenedores: detalle.reduce((a, d) => a + d.numContenedores, 0),
      detalle,
    };
  }

  /**
   * Eventos/envios de una ruta (p_expRutasDeca, accion=SELECT_ENVIOS). NO se llama desde ningun flujo: en cada
   * llamada LUX falla con 'Error al convertir una cadena de caracteres en fecha y/u hora' (queda un SEVERE en
   * lux.log por cada consulta) y devuelve cuerpo vacio, incluso para rutas que no existen. Solo para diagnostico.
   */
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

  /**
   * DECA de una ruta a partir de su ID (el que lleva `p_expRutas GENERAR_DECA` en el log), sin
   * resolver nombres. El log se escribe al EMPEZAR la accion, asi que el DECA puede tardar un
   * instante en existir: si aun no hay filas se reintenta (`reintentos` veces, `esperaMs` entre
   * medias). Devuelve `undefined` si tras los reintentos no hay DECA ni envios.
   */
  async consultarDecaPorId(
    idRuta: string,
    almacen?: string,
    esperaMs: number = 3000,
    reintentos: number = 2,
  ): Promise<RutaDecaConsulta | undefined> {
    const llamar = async (): Promise<{ filas: Array<Record<string, string>>; llamada: LlamadaApi }> => {
      const rows = await this.luxClient.callProc('p_expRutasDeca', 'SELECT', { id: idRuta }, {
        operacion: 'rutas.obtenerDecaPorId',
        almacen,
      });
      const filas = comoFilas<Record<string, string>>(rows);
      return { filas, llamada: { procedimiento: 'p_expRutasDeca', accion: 'SELECT', parametros: { id: idRuta }, almacen, filas: filas.length } };
    };
    for (let intento = 0; intento <= reintentos; intento += 1) {
      const deca = await llamar();
      if (deca.filas.length > 0) {
        const numeroRuta = numeroRutaDe(deca.filas[0]?.shipmentReference, idRuta);
        return {
          numeroRuta,
          deca: deca.filas as RutaDeca[],
          envios: [],
          totales: await this.obtenerTotalesRuta(numeroRuta, almacen).catch(() => undefined),
          consulta: { filtroLog: `GENERAR_DECA id=${idRuta}`, metodoResolucion: 'id-ruta', llamadas: [deca.llamada] },
        };
      }
      if (intento < reintentos) {
        await new Promise((resolve) => setTimeout(resolve, esperaMs));
      }
    }
    return undefined;
  }

  /** Resuelve el filtro y consulta el DECA (SELECT) de cada ruta resultante. */
  async consultarDeca(filtro: string, almacen?: string): Promise<RutaDecaConsulta[]> {
    const resolucion = await this.resolver(filtro, almacen);
    const resultados: RutaDecaConsulta[] = [];
    for (const numeroRuta of resolucion.numerosRuta) {
      const deca = await this.obtenerDeca(numeroRuta, almacen);
      resultados.push({
        numeroRuta,
        deca,
        envios: [], // SELECT_ENVIOS falla siempre en LUX (ver obtenerEnvios): no se consulta
        totales: await this.obtenerTotalesRuta(numeroRuta, almacen).catch(() => undefined),
        consulta: {
          filtroLog: filtro,
          metodoResolucion: resolucion.metodo,
          llamadas: [
            ...resolucion.llamadas,
            { procedimiento: 'p_expRutasDeca', accion: 'SELECT', parametros: { numeroRuta }, almacen, filas: deca.length },
          ],
        },
      });
    }
    return resultados;
  }
}
