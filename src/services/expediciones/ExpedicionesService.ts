import type { LuxClient } from '../../lux/client';
import { buildProcBody } from '../../lux/utils';
import { describeError, parseOrThrow, type LineaFallida } from '../shared';
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

export type { LineaFallida };

/** Vista completa de una expedicion: lo que necesitan la API, la interfaz web y el watcher. */
export interface ExpedicionDetalle {
  cabecera: Expedicion;
  datosExtra: Record<string, string>;
  lineas: ExpedicionLinea[];
  contenedores: ExpedicionContenedor[];
  /** Fila completa del visor (p_expedicionesAza): columnas que no trae p_expCabeceraAza
   *  (transportista, ruta, muelle, prioridad, etc.), ver docs/lux-api-analysis.md §6.3. */
  resumenListado: ExpedicionListItem | undefined;
  /** Datos de la RUTA asignada (p_expRutas): conductor (nombre, apellidos, DNI, telefono, email),
   *  matriculas, transportista, estado... `undefined` si el pedido no tiene ruta o no se encontro. */
  datosRuta: Record<string, string> | undefined;
  /** DECA de la ruta (p_expRutasDeca: SELECT y SELECT_ENVIOS). `undefined` si no hay ruta o no se pudo leer. */
  decaRuta: { deca: Array<Record<string, string>>; envios: Array<Record<string, string>> } | undefined;
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
          fallidas.push({ input: rawLinea as LineaExpedicionDTO, error: describeError(err) });
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

  /** Cabecera + datos extra + lineas + contenedores en paralelo y, despues, la fila del visor
   *  (que necesita `cabecera.pedido`). Unico punto que ensambla el detalle de una expedicion. */
  async obtenerDetalle(idPedido: string, almacen?: string): Promise<ExpedicionDetalle> {
    const [cabecera, datosExtra, lineas, contenedores] = await Promise.all([
      this.obtenerExpedicion(idPedido, almacen),
      this.obtenerDatosExtraExpedicion(idPedido, almacen),
      this.obtenerLineasExpedicion(idPedido, almacen),
      this.obtenerContenedoresExpedicion(idPedido, almacen),
    ]);
    const resumenListado = await this.obtenerResumenListadoExpedicion(cabecera.pedido, almacen);
    // Best effort: un fallo al leer la ruta no debe impedir ver el resto del detalle.
    const [datosRuta, decaRuta] = await Promise.all([
      this.obtenerDatosRuta(resumenListado?.ruta, almacen).catch(() => undefined),
      this.obtenerDecaDeRuta(resumenListado?.ruta, almacen).catch(() => undefined),
    ]);
    return { cabecera, datosExtra, lineas, contenedores, resumenListado, datosRuta, decaRuta };
  }

  /** DECA (p_expRutasDeca SELECT) y envios/eventos (SELECT_ENVIOS) de la ruta, por `numeroRuta` exacto.
   *  LUX devuelve cuerpo vacio ("") si no hay filas. Sin ruta (vacia o "NO ASIGNADA") no llama a LUX. */
  async obtenerDecaDeRuta(numeroRuta: string | undefined, almacen?: string): Promise<ExpedicionDetalle['decaRuta']> {
    const ruta = (numeroRuta ?? '').trim();
    if (ruta === '' || ruta.toUpperCase() === 'NO ASIGNADA') {
      return undefined;
    }
    const filas = async (accion: string): Promise<Array<Record<string, string>>> => {
      const rows: unknown = await this.luxClient.callProc('p_expRutasDeca', accion, { numeroRuta: ruta }, {
        operacion: 'expediciones.obtenerDecaDeRuta',
        almacen,
      });
      return Array.isArray(rows) ? (rows as Array<Record<string, string>>) : [];
    };
    const [deca, envios] = await Promise.all([filas('SELECT'), filas('SELECT_ENVIOS')]);
    return { deca, envios };
  }

  /**
   * Fila de la ruta (p_expRutas, accion=SELECT) por `numeroRuta` EXACTO: incluye los datos del
   * conductor y las matriculas (conductorNombre, conductorApellidos, conductorDni, conductorTelefono,
   * conductorEmail, matriculaTractora, matriculaRemolque, transportista, estado...). Sin ruta
   * (vacia o "NO ASIGNADA") no llama a LUX. LUX devuelve cuerpo vacio ("") si no hay filas.
   */
  async obtenerDatosRuta(numeroRuta: string | undefined, almacen?: string): Promise<Record<string, string> | undefined> {
    const ruta = (numeroRuta ?? '').trim();
    if (ruta === '' || ruta.toUpperCase() === 'NO ASIGNADA') {
      return undefined;
    }
    // Como el listado de expediciones, p_expRutas OCULTA por defecto las rutas ya enviadas: hay que
    // pedirlas con estado='ENVIADA'. Primero sin estado (lo habitual) y, si no hay fila, enviadas.
    for (const extra of [{}, { estado: 'ENVIADA' }] as Array<Record<string, string>>) {
      const rows: unknown = await this.luxClient.callProc('p_expRutas', 'SELECT', { numeroRuta: ruta, ...extra }, {
        operacion: 'expediciones.obtenerDatosRuta',
        almacen,
      });
      const fila = Array.isArray(rows) ? (rows[0] as Record<string, string> | undefined) : undefined;
      if (fila) {
        return fila;
      }
    }
    return undefined;
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
   * Plantilla de datos extra para una expedicion QUE TODAVIA NO EXISTE (antes de tener idPedido),
   * filtrada por propietario en vez de por idParent. Devuelve los mismos campos que
   * `obtenerDatosExtraExpedicion` (generarDeca, expedicion, observacionesAlbaran, fechaEntrega,
   * facturarTransporte, observacionesAlmacen, serviceLevel, carga) pero con valores por defecto
   * (normalmente vacios) segun la configuracion de ese propietario. Confirmado contra el servidor
   * real de LUX, ver docs/lux-api-analysis.md §16.
   */
  async obtenerDatosExtraExpedicionPorPropietario(propietario: string, almacen?: string): Promise<Record<string, string>> {
    const rows = await this.luxClient.callProc(
      'p_expCabeceraAza',
      'SELECT_INICIO',
      { propietario },
      { operacion: 'expediciones.obtenerDatosExtraExpedicionPorPropietario', almacen },
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
}
