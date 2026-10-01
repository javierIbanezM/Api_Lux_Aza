import type { LuxClient } from '../../lux/client';
import { buildProcBody } from '../../lux/utils';
import { describeError, parseOrThrow, type LineaFallida } from '../shared';
import type {
  Recepcion,
  RecepcionHU,
  RecepcionLinea,
  RecepcionListFilters,
  RecepcionListItem,
} from '../../lux/models';
import {
  crearRecepcionSchema,
  actualizarRecepcionCabeceraSchema,
  lineaRecepcionSchema,
  actualizarLineaRecepcionSchema,
  listarRecepcionesFiltersSchema,
  type CrearRecepcionDTO,
  type ActualizarRecepcionCabeceraDTO,
  type LineaRecepcionDTO,
  type ActualizarLineaRecepcionDTO,
  type ListarRecepcionesFiltersDTO,
} from '../../validation/recepciones';

export type { LineaFallida };

/** Vista de una recepcion: cabecera + datos extra + lineas (las zonas de descarga son de otro
 *  servicio, ver CatalogosService.selectDescargas). */
export interface RecepcionDetalle {
  cabecera: Recepcion;
  datosExtra: Record<string, string>;
  lineas: RecepcionLinea[];
}

export interface CrearRecepcionResult {
  mensaje: string;
  idAlbaran: string;
  albaran: string;
  cabecera: Recepcion;
  lineas: {
    ok: RecepcionLinea[];
    fallidas: LineaFallida<Omit<LineaRecepcionDTO, 'idParent'>>[];
  };
}

/**
 * Logica de aplicacion de AZA para recepciones (albaranes de entrada), sobre los procedimientos
 * p_recCabeceraAza / p_recAlbaranLineas / p_recepcionesAza.
 *
 * Todos los metodos aceptan un `almacen` opcional (cabecera "Almacen" de LUX para esa llamada);
 * si no se indica, LuxClient usa el almacen por defecto de la configuracion. Ver
 * src/lux/warehouses.ts para la lista de almacenes validos.
 */
export class RecepcionesService {
  constructor(private readonly luxClient: LuxClient) {}

  /**
   * Flujo completo de alta (docs/lux-api-analysis.md §8.2): crea la cabecera y, solo si tiene
   * exito, crea las lineas indicadas. Si la cabecera falla, NUNCA se crean lineas.
   */
  async crearRecepcion(input: CrearRecepcionDTO, almacen?: string): Promise<CrearRecepcionResult> {
    const dto = parseOrThrow(crearRecepcionSchema, input);
    const { lineas, ...cabeceraInput } = dto;

    const body = buildProcBody({ ...cabeceraInput, idAlbaran: '0' });
    const rows = await this.luxClient.callProc('p_recCabeceraAza', 'ACTUALIZAR', body, {
      operacion: 'recepciones.crearRecepcion.cabecera',
      almacen,
    });
    const cabecera = rows[0] as Recepcion;

    const ok: RecepcionLinea[] = [];
    const fallidas: LineaFallida<Omit<LineaRecepcionDTO, 'idParent'>>[] = [];

    if (lineas && lineas.length > 0) {
      for (const rawLinea of lineas) {
        // La validacion de esta linea vive DENTRO del try: si `rawLinea` no cumple el schema
        // (p.ej. falta "referencia"), el fallo se captura como cualquier otro error de la
        // linea y se reporta en `fallidas`, sin abortar el metodo completo. Eso es lo que
        // permite que la cabecera (ya creada en LUX en este punto) y las demas lineas validas
        // del mismo lote nunca se pierdan por culpa de una unica linea mal formada.
        try {
          const linea = parseOrThrow(lineaRecepcionSchema.omit({ idParent: true }), rawLinea);
          const lineaBody = buildProcBody({ ...linea, idParent: cabecera.idAlbaran });
          const lineaRows = await this.luxClient.callProc('p_recAlbaranLineas', 'INSERT', lineaBody, {
            operacion: 'recepciones.crearRecepcion.linea',
            almacen,
          });
          ok.push(lineaRows[0] as RecepcionLinea);
        } catch (err) {
          fallidas.push({
            input: rawLinea as Omit<LineaRecepcionDTO, 'idParent'>,
            error: describeError(err),
          });
        }
      }
    }

    return {
      mensaje: cabecera.mensaje,
      idAlbaran: cabecera.idAlbaran,
      albaran: cabecera.albaran,
      cabecera,
      lineas: { ok, fallidas },
    };
  }

  async actualizarRecepcion(input: ActualizarRecepcionCabeceraDTO, almacen?: string): Promise<Recepcion> {
    const dto = parseOrThrow(actualizarRecepcionCabeceraSchema, input);
    const body = buildProcBody(dto);
    const rows = await this.luxClient.callProc('p_recCabeceraAza', 'ACTUALIZAR', body, {
      operacion: 'recepciones.actualizarRecepcion',
      almacen,
    });
    return rows[0] as Recepcion;
  }

  async crearLineaRecepcion(input: LineaRecepcionDTO, almacen?: string): Promise<RecepcionLinea> {
    const dto = parseOrThrow(lineaRecepcionSchema, input);
    const body = buildProcBody(dto);
    const rows = await this.luxClient.callProc('p_recAlbaranLineas', 'INSERT', body, {
      operacion: 'recepciones.crearLineaRecepcion',
      almacen,
    });
    return rows[0] as RecepcionLinea;
  }

  async actualizarLineaRecepcion(input: ActualizarLineaRecepcionDTO, almacen?: string): Promise<RecepcionLinea> {
    const dto = parseOrThrow(actualizarLineaRecepcionSchema, input);
    const body = buildProcBody(dto);
    const rows = await this.luxClient.callProc('p_recAlbaranLineas', 'UPDATE', body, {
      operacion: 'recepciones.actualizarLineaRecepcion',
      almacen,
    });
    return rows[0] as RecepcionLinea;
  }

  /**
   * Listado de recepciones (p_recepcionesAza, accion=SELECT). IMPORTANTE (confirmado contra el
   * servidor real): sin filtro `estado`, LUX NO devuelve las recepciones en estado `CERRADO` --
   * a diferencia de expediciones, donde el listado sin filtro si incluye las `CERRADO`. En un
   * almacen real esto escondia 4018 recepciones `CERRADO` frente a solo 123 del resto de estados
   * combinados. Para que "sin filtro" signifique realmente "todas", cuando no se pide un `estado`
   * concreto se hace una segunda llamada pidiendo expresamente `estado='CERRADO'` y se fusiona.
   * Si el llamador SI filtra por un estado concreto, no se hace la llamada extra.
   */
  async listarRecepciones(filters: ListarRecepcionesFiltersDTO = {}, almacen?: string): Promise<RecepcionListItem[]> {
    const dto = parseOrThrow(listarRecepcionesFiltersSchema, filters);
    const body = buildProcBody(dto as RecepcionListFilters);
    const pedirNoCerradas = this.luxClient.callProc('p_recepcionesAza', 'SELECT', body, {
      operacion: 'recepciones.listarRecepciones',
      almacen,
    });
    if (dto.estado) {
      return (await pedirNoCerradas) as RecepcionListItem[];
    }
    // Las dos consultas son independientes: se lanzan en paralelo (antes, una tras otra).
    const [rows, cerradas] = await Promise.all([
      pedirNoCerradas,
      this.luxClient.callProc(
        'p_recepcionesAza',
        'SELECT',
        { ...body, estado: 'CERRADO' },
        { operacion: 'recepciones.listarRecepciones.cerradas', almacen },
      ),
    ]);
    return [...rows, ...cerradas] as RecepcionListItem[];
  }

  async obtenerRecepcion(idAlbaran: string, almacen?: string): Promise<Recepcion> {
    const rows = await this.luxClient.callProc(
      'p_recCabeceraAza',
      'SELECT_ONE',
      { idAlbaran },
      { operacion: 'recepciones.obtenerRecepcion', almacen },
    );
    return rows[0] as Recepcion;
  }

  /** Cabecera + datos extra + lineas en paralelo. Unico punto que ensambla el detalle. */
  async obtenerDetalle(idAlbaran: string, almacen?: string): Promise<RecepcionDetalle> {
    const [cabecera, datosExtra, lineas] = await Promise.all([
      this.obtenerRecepcion(idAlbaran, almacen),
      this.obtenerDatosExtraRecepcion(idAlbaran, almacen),
      this.obtenerLineasRecepcion(idAlbaran, almacen),
    ]);
    return { cabecera, datosExtra, lineas };
  }

  async obtenerDatosExtraRecepcion(idAlbaran: string, almacen?: string): Promise<Record<string, string>> {
    const rows = await this.luxClient.callProc(
      'p_recCabeceraAza',
      'SELECT_INICIO',
      { idParent: idAlbaran },
      { operacion: 'recepciones.obtenerDatosExtraRecepcion', almacen },
    );
    return rows[0] ?? {};
  }

  /**
   * Plantilla de datos extra para una recepcion QUE TODAVIA NO EXISTE (antes de tener idAlbaran),
   * filtrada por propietario en vez de por idParent. Devuelve los mismos campos que
   * `obtenerDatosExtraRecepcion` (apellidos, matRemolque, descarga, matricula, observacionesPDA,
   * telefono, bultosPrevistos, nombre, dni) pero con valores por defecto (normalmente vacios)
   * segun la configuracion de ese propietario. Confirmado contra el servidor real de LUX, ver
   * docs/lux-api-analysis.md §16.
   */
  async obtenerDatosExtraRecepcionPorPropietario(propietario: string, almacen?: string): Promise<Record<string, string>> {
    const rows = await this.luxClient.callProc(
      'p_recCabeceraAza',
      'SELECT_INICIO',
      { propietario },
      { operacion: 'recepciones.obtenerDatosExtraRecepcionPorPropietario', almacen },
    );
    return rows[0] ?? {};
  }

  async obtenerLineasRecepcion(idAlbaran: string, almacen?: string): Promise<RecepcionLinea[]> {
    const rows = await this.luxClient.callProc(
      'p_recAlbaranLineas',
      'SELECT',
      { idParent: idAlbaran },
      { operacion: 'recepciones.obtenerLineasRecepcion', almacen },
    );
    return rows as RecepcionLinea[];
  }

  /**
   * Fila completa del visor/listado (p_recepcionesAza, accion=SELECT) para un albaran conocido,
   * filtrando por `albaran` exacto (sin comodin). Usado por el watcher de logs (src/watcher/)
   * para resolver altas de recepcion (idAlbaran='0' en el log, solo se conoce el texto del
   * albaran hasta que LUX asigna el id real) -- ver docs/lux-api-analysis.md §16.
   */
  async obtenerResumenListadoRecepcion(albaran: string, almacen?: string): Promise<RecepcionListItem | undefined> {
    if (!albaran) {
      return undefined;
    }
    const rows = await this.luxClient.callProc(
      'p_recepcionesAza',
      'SELECT',
      { albaran },
      { operacion: 'recepciones.obtenerResumenListadoRecepcion', almacen },
    );
    return rows[0] as RecepcionListItem | undefined;
  }

  /**
   * HUs/pallets fisicos recepcionados de un albaran (p_recAlbaranHUPreinformado,
   * accion=SELECT_INICIO). Procedimiento no documentado en la guia del proveedor; confirmado
   * contra el servidor real de LUX, ver docs/lux-api-analysis.md §16. Solo lectura.
   */
  async obtenerHUsRecepcion(idAlbaran: string, almacen?: string): Promise<RecepcionHU[]> {
    const rows = await this.luxClient.callProc(
      'p_recAlbaranHUPreinformado',
      'SELECT_INICIO',
      { idParent: idAlbaran },
      { operacion: 'recepciones.obtenerHUsRecepcion', almacen },
    );
    return rows as RecepcionHU[];
  }
}
