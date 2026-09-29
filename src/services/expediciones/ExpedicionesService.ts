import type { LuxClient } from '../../lux/client';
import { buildProcBody } from '../../lux/utils';
import { LuxError, LuxValidationError } from '../../lux/errors';
import type {
  Expedicion,
  ExpedicionContenedor,
  ExpedicionLinea,
  ExpedicionListFilters,
  ExpedicionListItem,
} from '../../lux/models';
import {
  crearExpedicionSchema,
  actualizarExpedicionCabeceraSchema,
  lineaExpedicionSchema,
  actualizarLineaExpedicionSchema,
  listarExpedicionesFiltersSchema,
  type CrearExpedicionDTO,
  type ActualizarExpedicionCabeceraDTO,
  type LineaExpedicionDTO,
  type ActualizarLineaExpedicionDTO,
  type ListarExpedicionesFiltersDTO,
} from '../../validation/expediciones';

export interface LineaFallida<TInput> {
  input: TInput;
  error: string;
}

export interface CrearExpedicionResult {
  mensaje: string;
  idPedido: string;
  pedido: string;
  cabecera: Expedicion;
  lineas: {
    ok: ExpedicionLinea[];
    fallidas: LineaFallida<LineaExpedicionDTO>[];
  };
}

function parseOrThrow<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new LuxValidationError('Datos de entrada invalidos', result.error);
  }
  return result.data as T;
}

/**
 * Logica de aplicacion de AZA para expediciones (pedidos de salida), sobre los procedimientos
 * p_expCabeceraAza / p_expPedidoLineas / p_expedicionesAza. No conoce detalles HTTP de LUX
 * (eso vive en LuxClient); solo orquesta llamadas y aplica las reglas del documento funcional.
 *
 * Todos los metodos aceptan un `almacen` opcional (cabecera "Almacen" de LUX para esa llamada);
 * si no se indica, LuxClient usa el almacen por defecto de la configuracion. Ver
 * src/lux/warehouses.ts para la lista de almacenes validos.
 */
export class ExpedicionesService {
  constructor(private readonly luxClient: LuxClient) {}

  /**
   * Flujo completo de alta (docs/lux-api-analysis.md §8.1): crea la cabecera y, solo si tiene
   * exito, crea las lineas indicadas. Si la cabecera falla, se propaga el error y NUNCA se
   * intentan crear lineas.
   */
  async crearExpedicion(input: CrearExpedicionDTO, almacen?: string): Promise<CrearExpedicionResult> {
    const dto = parseOrThrow(crearExpedicionSchema, input);
    const { lineas, ...cabeceraInput } = dto;

    const body = buildProcBody({ ...cabeceraInput, idPedido: '0' });
    const rows = await this.luxClient.callProc('p_expCabeceraAza', 'ACTUALIZAR', body, {
      operacion: 'expediciones.crearExpedicion.cabecera',
      almacen,
    });
    const cabecera = rows[0] as Expedicion;

    const ok: ExpedicionLinea[] = [];
    const fallidas: LineaFallida<LineaExpedicionDTO>[] = [];

    if (lineas && lineas.length > 0) {
      for (const rawLinea of lineas) {
        // La validacion de esta linea vive DENTRO del try: si `rawLinea` no cumple el schema
        // (p.ej. falta "referencia"), el fallo se captura como cualquier otro error de la
        // linea y se reporta en `fallidas`, sin abortar el metodo completo. Eso es lo que
        // permite que la cabecera (ya creada en LUX en este punto) y las demas lineas validas
        // del mismo lote nunca se pierdan por culpa de una unica linea mal formada.
        try {
          const linea = parseOrThrow(lineaExpedicionSchema, rawLinea);
          const lineaBody = buildProcBody({ ...linea, pedido: linea.pedido ?? cabecera.pedido });
          const lineaRows = await this.luxClient.callProc('p_expPedidoLineas', 'INSERT', lineaBody, {
            operacion: 'expediciones.crearExpedicion.linea',
            almacen,
          });
          ok.push(lineaRows[0] as ExpedicionLinea);
        } catch (err) {
          fallidas.push({ input: rawLinea as LineaExpedicionDTO, error: this.describeError(err) });
        }
      }
    }

    return {
      mensaje: cabecera.mensaje,
      idPedido: cabecera.idPedido,
      pedido: cabecera.pedido,
      cabecera,
      lineas: { ok, fallidas },
    };
  }

  async actualizarExpedicion(input: ActualizarExpedicionCabeceraDTO, almacen?: string): Promise<Expedicion> {
    const dto = parseOrThrow(actualizarExpedicionCabeceraSchema, input);
    const body = buildProcBody(dto);
    const rows = await this.luxClient.callProc('p_expCabeceraAza', 'ACTUALIZAR', body, {
      operacion: 'expediciones.actualizarExpedicion',
      almacen,
    });
    return rows[0] as Expedicion;
  }

  async crearLineaExpedicion(input: LineaExpedicionDTO, almacen?: string): Promise<ExpedicionLinea> {
    const dto = parseOrThrow(lineaExpedicionSchema, input);
    const body = buildProcBody(dto);
    const rows = await this.luxClient.callProc('p_expPedidoLineas', 'INSERT', body, {
      operacion: 'expediciones.crearLineaExpedicion',
      almacen,
    });
    return rows[0] as ExpedicionLinea;
  }

  async actualizarLineaExpedicion(input: ActualizarLineaExpedicionDTO, almacen?: string): Promise<ExpedicionLinea> {
    const dto = parseOrThrow(actualizarLineaExpedicionSchema, input);
    const body = buildProcBody(dto);
    const rows = await this.luxClient.callProc('p_expPedidoLineas', 'UPDATE', body, {
      operacion: 'expediciones.actualizarLineaExpedicion',
      almacen,
    });
    return rows[0] as ExpedicionLinea;
  }

  async listarExpediciones(filters: ListarExpedicionesFiltersDTO = {}, almacen?: string): Promise<ExpedicionListItem[]> {
    const dto = parseOrThrow(listarExpedicionesFiltersSchema, filters);
    const body = buildProcBody(dto as ExpedicionListFilters);
    const rows = await this.luxClient.callProc('p_expedicionesAza', 'SELECT', body, {
      operacion: 'expediciones.listarExpediciones',
      almacen,
    });
    return rows as ExpedicionListItem[];
  }

  async obtenerExpedicion(idPedido: string, almacen?: string): Promise<Expedicion> {
    const rows = await this.luxClient.callProc(
      'p_expCabeceraAza',
      'SELECT_ONE',
      { idPedido },
      { operacion: 'expediciones.obtenerExpedicion', almacen },
    );
    return rows[0] as Expedicion;
  }

  async obtenerDatosExtraExpedicion(idPedido: string, almacen?: string): Promise<Record<string, string>> {
    const rows = await this.luxClient.callProc(
      'p_expCabeceraAza',
      'SELECT_INICIO',
      { idParent: idPedido },
      { operacion: 'expediciones.obtenerDatosExtraExpedicion', almacen },
    );
    return rows[0] ?? {};
  }

  /**
   * Fila completa del visor/listado (p_expedicionesAza, accion=SELECT) para un pedido conocido.
   * Trae columnas que NO devuelve p_expCabeceraAza (transportista, ruta, muelle, prioridad,
   * unidades, fechaCreacion, etc. -- ver docs/lux-api-analysis.md §6.3), utiles para el detalle.
   * Filtra por `pedido` exacto (sin comodin "%"): la documentacion no permite filtrar el listado
   * por `id`, solo por `pedido` (texto). Si `pedido` viene vacio, no llama a LUX.
   */
  async obtenerResumenListadoExpedicion(pedido: string, almacen?: string): Promise<ExpedicionListItem | undefined> {
    if (!pedido) {
      return undefined;
    }
    const rows = await this.luxClient.callProc(
      'p_expedicionesAza',
      'SELECT',
      { pedido },
      { operacion: 'expediciones.obtenerResumenListadoExpedicion', almacen },
    );
    return rows[0] as ExpedicionListItem | undefined;
  }

  async obtenerLineasExpedicion(idPedido: string, almacen?: string): Promise<ExpedicionLinea[]> {
    const rows = await this.luxClient.callProc(
      'p_expPedidoLineas',
      'SELECT',
      { idParent: idPedido },
      { operacion: 'expediciones.obtenerLineasExpedicion', almacen },
    );
    return rows as ExpedicionLinea[];
  }

  /**
   * Contenedores/bultos de una expedicion (p_expPedidoContenedores, accion=SELECT_INICIO).
   * Procedimiento no documentado en la guia del proveedor; confirmado contra el servidor real,
   * ver docs/lux-api-analysis.md §14. Solo lectura.
   */
  async obtenerContenedoresExpedicion(idPedido: string, almacen?: string): Promise<ExpedicionContenedor[]> {
    const rows = await this.luxClient.callProc(
      'p_expPedidoContenedores',
      'SELECT_INICIO',
      { idParent: idPedido },
      { operacion: 'expediciones.obtenerContenedoresExpedicion', almacen },
    );
    return rows as ExpedicionContenedor[];
  }

  private describeError(err: unknown): string {
    if (err instanceof LuxError) {
      return err.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
