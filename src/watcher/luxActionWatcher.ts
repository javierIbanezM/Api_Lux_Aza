import type { Logger } from '../logging';
import type { ExpedicionesService } from '../services/expediciones';
import type { RecepcionesService } from '../services/recepciones';
import type { LuxClient } from '../lux/client';
import type { Expedicion, ExpedicionContenedor, ExpedicionLinea, Recepcion, RecepcionLinea } from '../lux/models';
import { LogTailer } from './logTailer';
import { matchActionLine, type ActionEventType, type DetectedEvent } from './actionPatterns';
import { resolverPedidosDeRuta } from './routeResolver';
import type { WatcherConfig } from './watcherConfig';
import { noopWatcherSink, type ExpedicionActualizada, type AlbaranActualizado, type WatcherSink } from './watcherSink';

type PendingTarget =
  | { domain: 'expedicion'; idPedido?: string; pedido?: string }
  | { domain: 'recepcion'; idAlbaran?: string; albaran?: string };

interface PendingRefresh {
  target: PendingTarget;
  motivos: Set<ActionEventType>;
  timer: ReturnType<typeof setTimeout>;
}

/** Clave de agrupacion para el debounce: prioriza el id interno (mas especifico); si solo hay
 *  texto de pedido/albaran (p.ej. una alta, id='0' todavia) usa ese. `undefined` = sin
 *  referencia resoluble en absoluto. */
function keyFor(target: PendingTarget): string | undefined {
  if (target.domain === 'expedicion') {
    if (target.idPedido && target.idPedido !== '0') {
      return `exp:id:${target.idPedido}`;
    }
    if (target.pedido) {
      return `exp:pedido:${target.pedido}`;
    }
    return undefined;
  }
  if (target.idAlbaran && target.idAlbaran !== '0') {
    return `rec:id:${target.idAlbaran}`;
  }
  if (target.albaran) {
    return `rec:albaran:${target.albaran}`;
  }
  return undefined;
}

/** Combina la referencia nueva con la ya pendiente, quedandose con el dato mas especifico
 *  disponible de cada campo (p.ej. si la primera linea solo traia `pedido` y una segunda linea
 *  del mismo pedido trae ademas `idPedido`, se conserva `idPedido`). */
function mergeTarget(previous: PendingTarget, incoming: PendingTarget): PendingTarget {
  if (previous.domain === 'expedicion' && incoming.domain === 'expedicion') {
    return { domain: 'expedicion', idPedido: incoming.idPedido ?? previous.idPedido, pedido: incoming.pedido ?? previous.pedido };
  }
  if (previous.domain === 'recepcion' && incoming.domain === 'recepcion') {
    return { domain: 'recepcion', idAlbaran: incoming.idAlbaran ?? previous.idAlbaran, albaran: incoming.albaran ?? previous.albaran };
  }
  return incoming;
}

/**
 * Vigila los logs de LUX (oficina + mobile) en busca de acciones de negocio confirmadas (ver
 * docs/lux-api-analysis.md §16) y, cuando aparecen, re-consulta el pedido/albaran afectado contra
 * la API de LUX (via ExpedicionesService/RecepcionesService, reutilizando la misma capa que usa
 * el servidor HTTP) para registrar su estado actualizado.
 *
 * Es "mejor esfuerzo", no una fuente de verdad transaccional: si se pierde una linea de log (el
 * proceso estaba parado, el fichero no era accesible un momento) no hay reintento retroactivo
 * mas alla de lo que el propio sondeo alcance a leer la siguiente vez.
 *
 * Varias lineas seguidas del mismo pedido/albaran en una ventana corta (`config.debounceMs`) se
 * agrupan en una unica re-consulta, no una por linea.
 *
 * Tras cada re-consulta correcta, ademas de dejar constancia en el log, se llama al `sink`
 * (ver watcherSink.ts) para el paso 3 del flujo (persistir en el destino de AZA). Por defecto es
 * un no-op (`noopWatcherSink`): a falta de que AZA indique la base de datos/sistema destino, el
 * comportamiento sigue siendo solo-log, pero el punto de enganche ya esta listo.
 */
export class LuxActionWatcher {
  private readonly pending = new Map<string, PendingRefresh>();
  private readonly luxTailer: LogTailer;
  private readonly mobileTailer: LogTailer;
  private pollHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly config: WatcherConfig,
    private readonly luxClient: LuxClient,
    private readonly expedicionesService: ExpedicionesService,
    private readonly recepcionesService: RecepcionesService,
    private readonly logger: Logger,
    private readonly sink: WatcherSink = noopWatcherSink,
  ) {
    this.luxTailer = new LogTailer(
      config.luxLogPath,
      (lines) => this.handleLines(lines),
      (err) => this.handleTailError(err, 'LUX', config.luxLogPath),
    );
    this.mobileTailer = new LogTailer(
      config.luxMobileLogPath,
      (lines) => this.handleLines(lines),
      (err) => this.handleTailError(err, 'LUX_mobile', config.luxMobileLogPath),
    );
  }

  start(): void {
    this.logger.info('Watcher de logs LUX iniciado', {
      operacion: 'watcher.start',
      resultado: 'OK',
      luxLogPath: this.config.luxLogPath,
      luxMobileLogPath: this.config.luxMobileLogPath,
      pollIntervalMs: this.config.pollIntervalMs,
      debounceMs: this.config.debounceMs,
    });
    this.pollHandle = setInterval(() => {
      void this.luxTailer.poll();
      void this.mobileTailer.poll();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private handleTailError(err: unknown, origen: string, path: string): void {
    this.logger.warn('Error leyendo log de LUX (se reintenta en el siguiente sondeo)', {
      operacion: 'watcher.tailError',
      resultado: 'ERROR',
      origen,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private handleLines(lines: string[]): void {
    for (const line of lines) {
      const event = matchActionLine(line);
      if (!event) {
        continue;
      }
      this.logger.debug('Linea de log coincide con una accion vigilada', {
        operacion: 'watcher.matched',
        tipo: event.type,
      });

      if (event.type === 'rutaEnviada') {
        void this.handleRutaEnviada(event);
        continue;
      }

      if (event.idAlbaran !== undefined || event.albaran !== undefined) {
        this.scheduleRefresh({ domain: 'recepcion', idAlbaran: event.idAlbaran, albaran: event.albaran }, event.type);
      } else {
        this.scheduleRefresh({ domain: 'expedicion', idPedido: event.idPedido, pedido: event.pedido }, event.type);
      }
    }
  }

  private async handleRutaEnviada(event: DetectedEvent): Promise<void> {
    try {
      const pedidos = await resolverPedidosDeRuta(this.luxClient, event.idRuta as string);
      if (pedidos.length === 0) {
        this.logger.warn('Ruta enviada pero no se resolvio ningun pedido asociado', {
          operacion: 'watcher.rutaSinPedidos',
          resultado: 'ERROR',
          idRuta: event.idRuta,
        });
        return;
      }
      for (const idPedido of pedidos) {
        this.scheduleRefresh({ domain: 'expedicion', idPedido }, 'rutaEnviada');
      }
    } catch (err) {
      this.logger.error('No se pudo resolver los pedidos de la ruta enviada', {
        operacion: 'watcher.resolverRutaError',
        resultado: 'ERROR',
        idRuta: event.idRuta,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleRefresh(target: PendingTarget, motivo: ActionEventType): void {
    const key = keyFor(target);
    if (!key) {
      this.logger.warn('Evento detectado sin referencia resoluble a un pedido/albaran', {
        operacion: 'watcher.sinReferencia',
        resultado: 'ERROR',
        tipo: motivo,
      });
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.motivos.add(motivo);
      existing.target = mergeTarget(existing.target, target);
      existing.timer = setTimeout(() => void this.refresh(key), this.config.debounceMs);
      return;
    }
    const timer = setTimeout(() => void this.refresh(key), this.config.debounceMs);
    this.pending.set(key, { target, motivos: new Set([motivo]), timer });
  }

  private async refresh(key: string): Promise<void> {
    const entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry) {
      return;
    }
    const motivosList = [...entry.motivos];
    const motivos = motivosList.join(',');
    const startedAt = Date.now();

    try {
      if (entry.target.domain === 'expedicion') {
        const result = await this.refreshExpedicion(entry.target);
        this.logger.info('Pedido actualizado tras deteccion en log', {
          operacion: 'watcher.pedidoActualizado',
          resultado: 'OK',
          idPedido: result.idPedido,
          pedido: result.pedido,
          propietario: result.propietario,
          estado: result.estado,
          lineasCount: result.lineas.length,
          contenedoresCount: result.contenedores.length,
          motivos,
          duracionMs: Date.now() - startedAt,
        });
        await this.callSink(
          () => this.sink.onExpedicionActualizada?.({ ...result, motivos: motivosList }),
          'expedicion',
        );
      } else {
        const result = await this.refreshRecepcion(entry.target);
        this.logger.info('Albaran actualizado tras deteccion en log', {
          operacion: 'watcher.albaranActualizado',
          resultado: 'OK',
          idAlbaran: result.idAlbaran,
          albaran: result.albaran,
          propietario: result.propietario,
          estado: result.estado,
          lineasCount: result.lineas.length,
          motivos,
          duracionMs: Date.now() - startedAt,
        });
        await this.callSink(
          () => this.sink.onAlbaranActualizado?.({ ...result, motivos: motivosList }),
          'recepcion',
        );
      }
    } catch (err) {
      this.logger.error('No se pudo re-consultar tras deteccion en log', {
        operacion: 'watcher.refreshError',
        resultado: 'ERROR',
        motivos,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Invoca el sink de persistencia (paso 3: guardar en destino AZA) sin dejar que un fallo ahi
   *  se confunda con un fallo de la re-consulta a LUX (que ya se registro por separado, arriba). */
  private async callSink(fn: () => Promise<void> | void, dominio: 'expedicion' | 'recepcion'): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error('El sink de persistencia fallo tras un refresco correcto (el estado ya quedo registrado en el log anterior)', {
        operacion: 'watcher.sinkError',
        resultado: 'ERROR',
        dominio,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Ejecuta `fn`; si falla, registra un aviso (`watcher.datoIncompleto`) y devuelve `undefined` en
   *  vez de propagar el error. Usado para lineas/contenedores: son parte de la "llamada api
   *  completa" pedida, pero no deben hacer fallar todo el refresco si solo esa llamada concreta
   *  falla (p.ej. un pedido recien creado que aun no tiene contenedores no deberia ser un error). */
  private async fetchBestEffort<T>(fn: () => Promise<T>, dato: string): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`No se pudo obtener "${dato}" en la re-consulta completa (se continua sin este dato)`, {
        operacion: 'watcher.datoIncompleto',
        resultado: 'ERROR',
        dato,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Re-consulta "completa" de una expedicion: cabecera (p_expCabeceraAza) + lineas
   *  (p_expPedidoLineas) + contenedores (p_expPedidoContenedores), no solo el resumen del listado.
   *  Las 3 llamadas se hacen siempre que se conoce el idPedido, independientemente de cual haya
   *  sido el motivo concreto que disparo el refresco (cabecera, linea, pasar a almacen...). */
  private async refreshExpedicion(
    target: Extract<PendingTarget, { domain: 'expedicion' }>,
  ): Promise<Omit<ExpedicionActualizada, 'motivos'>> {
    const idPedidoDirecto = target.idPedido && target.idPedido !== '0' ? target.idPedido : undefined;
    let pedido = target.pedido;
    let cabecera: Expedicion | undefined;

    if (idPedidoDirecto) {
      cabecera = await this.expedicionesService.obtenerExpedicion(idPedidoDirecto);
      pedido = pedido ?? cabecera.pedido;
    }
    if (!pedido) {
      throw new Error('No se pudo determinar el numero de pedido para re-consultar (sin idPedido ni pedido)');
    }

    const resumen = await this.expedicionesService.obtenerResumenListadoExpedicion(pedido);
    const idPedido = idPedidoDirecto ?? resumen?.id;

    let lineas: ExpedicionLinea[] = [];
    let contenedores: ExpedicionContenedor[] = [];
    if (idPedido) {
      if (!cabecera) {
        cabecera = await this.fetchBestEffort(() => this.expedicionesService.obtenerExpedicion(idPedido), 'cabecera');
      }
      lineas = (await this.fetchBestEffort(() => this.expedicionesService.obtenerLineasExpedicion(idPedido), 'lineas')) ?? [];
      contenedores =
        (await this.fetchBestEffort(() => this.expedicionesService.obtenerContenedoresExpedicion(idPedido), 'contenedores')) ?? [];
    }

    return {
      idPedido,
      pedido,
      propietario: resumen?.propietario,
      estado: resumen?.estado,
      cabecera,
      lineas,
      contenedores,
    };
  }

  /** Re-consulta "completa" de una recepcion: cabecera (p_recCabeceraAza) + lineas
   *  (p_recAlbaranLineas), no solo el resumen del listado (no existe equivalente de
   *  "contenedores" documentado/confirmado para recepciones). */
  private async refreshRecepcion(
    target: Extract<PendingTarget, { domain: 'recepcion' }>,
  ): Promise<Omit<AlbaranActualizado, 'motivos'>> {
    const idAlbaranDirecto = target.idAlbaran && target.idAlbaran !== '0' ? target.idAlbaran : undefined;
    let albaran = target.albaran;
    let cabecera: Recepcion | undefined;

    if (idAlbaranDirecto) {
      cabecera = await this.recepcionesService.obtenerRecepcion(idAlbaranDirecto);
      albaran = albaran ?? cabecera.albaran;
    }
    if (!albaran) {
      throw new Error('No se pudo determinar el numero de albaran para re-consultar (sin idAlbaran ni albaran)');
    }

    const resumen = await this.recepcionesService.obtenerResumenListadoRecepcion(albaran);
    const idAlbaran = idAlbaranDirecto ?? resumen?.id;

    let lineas: RecepcionLinea[] = [];
    if (idAlbaran) {
      if (!cabecera) {
        cabecera = await this.fetchBestEffort(() => this.recepcionesService.obtenerRecepcion(idAlbaran), 'cabecera');
      }
      lineas = (await this.fetchBestEffort(() => this.recepcionesService.obtenerLineasRecepcion(idAlbaran), 'lineas')) ?? [];
    }

    return {
      idAlbaran,
      albaran,
      propietario: resumen?.propietario,
      estado: resumen?.estado,
      cabecera,
      lineas,
    };
  }
}
