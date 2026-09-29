import type { LuxClient } from '../../lux/client';
import { buildProcBody } from '../../lux/utils';
import { LuxError, LuxValidationError } from '../../lux/errors';
import type {
  Recepcion,
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

export interface LineaFallida<TInput> {
  input: TInput;
  error: string;
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

function parseOrThrow<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new LuxValidationError('Datos de entrada invalidos', result.error);
  }
  return result.data as T;
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
            error: this.describeError(err),
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

  async listarRecepciones(filters: ListarRecepcionesFiltersDTO = {}, almacen?: string): Promise<RecepcionListItem[]> {
    const dto = parseOrThrow(listarRecepcionesFiltersSchema, filters);
    const body = buildProcBody(dto as RecepcionListFilters);
    const rows = await this.luxClient.callProc('p_recepcionesAza', 'SELECT', body, {
      operacion: 'recepciones.listarRecepciones',
      almacen,
    });
    return rows as RecepcionListItem[];
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

  async obtenerDatosExtraRecepcion(idAlbaran: string, almacen?: string): Promise<Record<string, string>> {
    const rows = await this.luxClient.callProc(
      'p_recCabeceraAza',
      'SELECT_INICIO',
      { idParent: idAlbaran },
      { operacion: 'recepciones.obtenerDatosExtraRecepcion', almacen },
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

  private describeError(err: unknown): string {
    if (err instanceof LuxError) {
      return err.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
