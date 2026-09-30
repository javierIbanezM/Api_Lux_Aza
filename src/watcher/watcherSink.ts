import type { ActionEventType } from './actionPatterns';
import type { Expedicion, ExpedicionContenedor, ExpedicionLinea, Recepcion, RecepcionLinea } from '../lux/models';

export interface ExpedicionActualizada {
  idPedido?: string;
  pedido: string;
  propietario?: string;
  estado?: string;
  motivos: ActionEventType[];
  /** Cabecera completa (p_expCabeceraAza), si se pudo obtener. */
  cabecera?: Expedicion;
  /** Lineas del pedido (p_expPedidoLineas, accion=SELECT). */
  lineas: ExpedicionLinea[];
  /** Contenedores/bultos del pedido (p_expPedidoContenedores, accion=SELECT_INICIO). */
  contenedores: ExpedicionContenedor[];
}

export interface AlbaranActualizado {
  idAlbaran?: string;
  albaran: string;
  propietario?: string;
  estado?: string;
  motivos: ActionEventType[];
  /** Cabecera completa (p_recCabeceraAza), si se pudo obtener. */
  cabecera?: Recepcion;
  /** Lineas del albaran (p_recAlbaranLineas, accion=SELECT). */
  lineas: RecepcionLinea[];
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
}

export const noopWatcherSink: WatcherSink = {};
