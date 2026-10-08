import type { ActionEventType } from './actionPatterns';
import type { DescargaDocumento } from '../docuten';
import type {
  LlamadaApi,
  RutaDeca,
  RutaDecaEnvio,
  Expedicion,
  ExpedicionContenedor,
  ExpedicionLinea,
  ExpedicionListItem,
  Recepcion,
  RecepcionHU,
  RecepcionLinea,
  RecepcionListItem,
} from '../lux/models';

export interface ExpedicionActualizada {
  idPedido?: string;
  pedido: string;
  /** Almacen real de este pedido (ver actionPatterns.ts): los mismos 2 ficheros de log traen
   *  actividad de los 5 almacenes, asi que esto NO es el almacen por defecto de la configuracion,
   *  es el que llevaba la linea de log que disparo este evento. */
  almacen?: string;
  /** Terminal (PDA) de la ultima linea de log que disparo el refresco (`@terminal=`), si la traia. */
  terminal?: string;
  propietario?: string;
  estado?: string;
  motivos: ActionEventType[];
  /** Cabecera completa (p_expCabeceraAza), si se pudo obtener. */
  cabecera?: Expedicion;
  /** Fila completa del listado (p_expedicionesAza, accion=SELECT). Trae columnas que NO estan en
   *  `cabecera` (transportista, ruta, muelle, prioridad, deliveryNumber, fechaCerrado, unidades,
   *  pallets, numContenedores, serviceLevel/nivelServicio, etc. -- ver
   *  docs/lux-api-analysis.md §6.3). `propietario`/`estado` de arriba vienen de aqui, pero esta
   *  fila trae mucho mas que esos dos campos. */
  listado?: ExpedicionListItem;
  /** Datos extra del pedido (p_expCabeceraAza, accion=SELECT_INICIO): campos como generarDeca,
   *  serviceLevel, carga, fechaEntrega... Lo mismo que muestra el detalle de la API. */
  datosExtra?: Record<string, string>;
  /** Datos de la ruta del pedido (p_expRutas): conductor, DNI, telefono, matriculas, transportista... */
  datosRuta?: Record<string, string>;
  /** Peligrosidad por referencias (p_manReferenciasADR): 'ADR' / 'LQ' si al menos una referencia del
   *  pedido lo es, `null` si ninguna. Es la columna `peligrosidad` de la tabla de planificacion. */
  peligrosidad?: { valor: 'ADR' | 'LQ' | null; referencias: Array<{ referencia: string; descripcion: string; adr: 'ADR' | 'LQ' }> };
  /** Lineas del pedido (p_expPedidoLineas, accion=SELECT). */
  lineas: ExpedicionLinea[];
  /** Contenedores/bultos del pedido (p_expPedidoContenedores, accion=SELECT_INICIO). */
  contenedores: ExpedicionContenedor[];
}

export interface AlbaranActualizado {
  idAlbaran?: string;
  albaran: string;
  /** Almacen real de este albaran (ver actionPatterns.ts), no el por defecto de la configuracion. */
  almacen?: string;
  /** Terminal (PDA) de la ultima linea de log que disparo el refresco (`@terminal=`), si la traia. */
  terminal?: string;
  propietario?: string;
  estado?: string;
  motivos: ActionEventType[];
  /** Cabecera completa (p_recCabeceraAza), si se pudo obtener. */
  cabecera?: Recepcion;
  /** Fila completa del listado (p_recepcionesAza, accion=SELECT). Igual que en expediciones,
   *  trae columnas que no estan en `cabecera`; `propietario`/`estado` de arriba salen de aqui. */
  listado?: RecepcionListItem;
  /** Datos extra del albaran (p_recCabeceraAza, accion=SELECT_INICIO): matricula, descarga, nombre,
   *  telefono... Lo mismo que muestra el detalle de la API. */
  datosExtra?: Record<string, string>;
  /** Lineas del albaran (p_recAlbaranLineas, accion=SELECT). */
  lineas: RecepcionLinea[];
  /** HUs/pallets fisicos recepcionados (p_recAlbaranHUPreinformado, accion=SELECT_INICIO).
   *  Equivalente de "contenedores" en expediciones; aqui es donde aparece el codigo de HU
   *  escaneado en la PDA (ver `recepcionLineaConfirmada`/`recepcionCerradaPicking`). */
  hus: RecepcionHU[];
}

/** DECA de una ruta (p_expRutasDeca SELECT) tras detectar que alguien consulto
 *  esa ruta en la pantalla de expediciones. Solo se emite si la ruta tiene DECA o envios. */
export interface RutaDecaActualizada {
  /** Nombre EXACTO de la ruta (resuelto a partir del filtro del log). */
  numeroRuta: string;
  /** Filtro tal como llego en el log, con comodines (p.ej. `%RT00013615_2026_COMP %`). */
  consultaOriginal: string;
  almacen?: string;
  terminal?: string;
  motivos: ActionEventType[];
  consultadoEn: string;
  /** La consulta hecha a la API de LUX que produjo estos datos: como se resolvio el nombre de la
   *  ruta y cada llamada (procedimiento, accion, parametros, almacen, numero de filas). */
  consulta: {
    filtroLog: string;
    metodoResolucion: 'listado' | 'listado-enviado' | 'filtro-literal' | 'id-ruta';
    llamadas: LlamadaApi[];
  };
  /** p_expRutasDeca accion=SELECT. */
  deca: RutaDeca[];
  /** Siempre vacio: p_expRutasDeca SELECT_ENVIOS falla en LUX en cada llamada y ya no se consulta (se mantiene el campo por compatibilidad). */
  envios: RutaDecaEnvio[];
  /** Pedidos que lleva la ruta y total de `pallets` y `numContenedores` (suma del listado de expediciones). */
  pedidos?: number;
  pallets?: number;
  numContenedores?: number;
  /** Aporte de cada pedido de la ruta a esos totales. */
  pedidosDetalle?: Array<{ id: string; pedido: string; propietario: string; estado: string; pallets: number; numContenedores: number }>;
  /** Descargas de documentos en Docuten (2 por envio: include=all y simple). Vacio si no hay
   *  clave de Docuten configurada o el DECA no tiene shipmentId. Llevan el contenido (`datos`);
   *  el sink guarda los ficheros y deja solo los metadatos en el JSON. */
  descargas: DescargaDocumento[];
}

/** Envio de una ruta de transporte (`p_expRutas` ENVIAR_FORZAR) que NO se pudo resolver a ningun
 *  pedido: en LUX la ruta estaba vacia (sin lineas en `p_expRutasDetalle`) al enviarla. Se
 *  registra igualmente para que el evento no se pierda en silencio. */
export interface RutaEnviadaSinPedidos {
  idRuta: string;
  almacen?: string;
  /** Terminal (PDA) de la linea de log, si la traia. */
  terminal?: string;
  /** Momento (ISO) en que el watcher detecto el envio. */
  detectadoEn: string;
  /** Siempre vacio: es el motivo de este registro. */
  pedidos: string[];
}

/**
 * Punto de extension para el paso 3 del flujo (evento detectado -> llamada API completa -> persistir
 * en destino AZA). El watcher llama a esto SOLO despues de re-consultar con exito el estado actual
 * en LUX; para expediciones eso incluye cabecera (p_expCabeceraAza), lineas (p_expPedidoLineas) y
 * contenedores (p_expPedidoContenedores) -- las 3 llamadas, no solo el resumen. `lineas` y
 * `contenedores` son "best effort": si esa llamada en concreto falla, se registra un aviso
 * (`watcher.datoIncompleto`) y se envian como array vacio, sin abortar el resto del refresco.
 *
 * Un sink que lanza excepcion no hace fallar el refresco: el resultado ya quedo registrado en el
 * log (`watcher.pedidoActualizado`/`watcher.albaranActualizado`) antes de invocar el sink, y un
 * fallo aqui se registra aparte como `watcher.sinkError`, sin reintento automatico.
 *
 * Todavia no hay ninguna implementacion real: falta que AZA facilite el destino (base de datos,
 * tabla/esquema, u otro sistema) al que escribir estas actualizaciones. Mientras tanto
 * `LuxActionWatcher` usa el sink por defecto (`noopWatcherSink`), que no hace nada, y el
 * comportamiento es identico al de antes de este cambio.
 */
export interface WatcherSink {
  onExpedicionActualizada?(result: ExpedicionActualizada): Promise<void> | void;
  onAlbaranActualizado?(result: AlbaranActualizado): Promise<void> | void;
  onRutaEnviadaSinPedidos?(result: RutaEnviadaSinPedidos): Promise<void> | void;
  onRutaDecaActualizada?(result: RutaDecaActualizada): Promise<void> | void;
}

/**
 * Destino definitivo (base de datos de AZA) al que se vuelca el estado FINAL de un pedido/albaran
 * (expedicion `ENVIADO`, recepcion `CERRADO`). Cada metodo debe resolverse SOLO cuando el destino
 * ha confirmado el guardado sin errores, y lanzar si algo falla: `createJsonFileSink` solo borra
 * el JSON provisional tras esa confirmacion (ver jsonFileSink.ts).
 */
export interface DestinoPersistencia {
  guardarExpedicion(result: ExpedicionActualizada): Promise<void>;
  guardarAlbaran(result: AlbaranActualizado): Promise<void>;
}

export const noopWatcherSink: WatcherSink = {};
