import { join } from 'node:path';
import type { Logger } from '../logging';
import type { ExpedicionesService } from '../services/expediciones';
import type { RecepcionesService } from '../services/recepciones';
import type { LuxClient } from '../lux/client';
import { LuxAuthError, LuxHttpError, LuxNetworkError } from '../lux/errors';
import type { Expedicion, ExpedicionContenedor, ExpedicionLinea, Recepcion, RecepcionHU, RecepcionLinea } from '../lux/models';
import { LogTailer } from './logTailer';
import { matchActionLine, type ActionEventType, type DetectedEvent } from './actionPatterns';
import { resolverPedidosDeRuta } from './routeResolver';
import type { WatcherConfig } from './watcherConfig';
import { noopWatcherSink, type ExpedicionActualizada, type AlbaranActualizado, type WatcherSink } from './watcherSink';

type PendingTarget =
  | { domain: 'expedicion'; idPedido?: string; pedido?: string; almacen?: string; terminal?: string }
  | { domain: 'recepcion'; idAlbaran?: string; albaran?: string; almacen?: string; terminal?: string };

interface PendingRefresh {
  target: PendingTarget;
  motivos: Set<ActionEventType>;
  timer: ReturnType<typeof setTimeout>;
  /** Momento (ms) de la primera linea agrupada: el debounce no puede aplazar el refresco mas
   *  alla de `firstAt + config.maxWaitMs`, aunque sigan llegando lineas. */
  firstAt: number;
  /** Reintentos ya hechos por fallo transitorio (LUX/red/sink). */
  attempts: number;
}

/** Cada cuanto como maximo se persiste la posicion de los logs (cuando todo esta procesado). */
const COMMIT_INTERVAL_MS = 5_000;
/** Tope del retraso entre reintentos de un refresco fallido. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Error de infraestructura que se resuelve esperando (LUX caido, red, token): el evento NO se
 *  da por perdido, se reintenta. Un error funcional/de datos no se reintenta (daria igual). */
function isTransientLuxError(err: unknown): boolean {
  return (
    err instanceof LuxNetworkError ||
    err instanceof LuxAuthError ||
    (err instanceof LuxHttpError && err.isTransient)
  );
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
    return {
      domain: 'expedicion',
      idPedido: incoming.idPedido ?? previous.idPedido,
      pedido: incoming.pedido ?? previous.pedido,
      almacen: incoming.almacen ?? previous.almacen,
      terminal: incoming.terminal ?? previous.terminal,
    };
  }
  if (previous.domain === 'recepcion' && incoming.domain === 'recepcion') {
    return {
      domain: 'recepcion',
      idAlbaran: incoming.idAlbaran ?? previous.idAlbaran,
      albaran: incoming.albaran ?? previous.albaran,
      almacen: incoming.almacen ?? previous.almacen,
      terminal: incoming.terminal ?? previous.terminal,
    };
  }
  return incoming;
}

/**
 * Vigila los logs de LUX (oficina + mobile) en busca de acciones de negocio confirmadas (ver
 * docs/lux-api-analysis.md §16) y, cuando aparecen, re-consulta el pedido/albaran afectado contra
 * la API de LUX (via ExpedicionesService/RecepcionesService, reutilizando la misma capa que usa
 * el servidor HTTP) para registrar su estado actualizado.
 *
 * Garantia de no perder eventos (al menos una vez): la posicion leida de cada log solo se
 * persiste (LogTailer.commit) cuando NO queda nada pendiente, en curso ni en reintento. Si el
 * proceso se para o cae a mitad, al arrancar se vuelve a leer desde la ultima posicion confirmada
 * y se reprocesa (el refresco es idempotente: re-consulta el estado actual). Un refresco que
 * falla por causa transitoria (LUX/red/token/sink) se reintenta hasta que salga bien.
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
  /** Ultimo refresco en curso por pedido/albaran: los refrescos de una misma clave se ejecutan en
   *  orden, para que un resultado mas antiguo (consulta lenta) nunca pise a uno mas reciente. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Refrescos fallidos por causa transitoria, esperando su reintento. */
  private readonly retries = new Map<string, PendingRefresh>();
  /** Rutas enviadas cuya resolucion a pedidos fallo por causa transitoria, esperando reintento. */
  private readonly rutaRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Resoluciones de ruta en curso. */
  private activeRutas = 0;
  private lastCommitAt = 0;
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
      join(config.stateDir, 'lux.state.json'),
      false,
    );
    this.mobileTailer = new LogTailer(
      config.luxMobileLogPath,
      (lines) => this.handleLines(lines),
      (err) => this.handleTailError(err, 'LUX_mobile', config.luxMobileLogPath),
      join(config.stateDir, 'lux-mobile.state.json'),
      false,
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
      maxWaitMs: this.config.maxWaitMs,
      retryDelayMs: this.config.retryDelayMs,
    });
    this.pollHandle = setInterval(() => {
      void this.luxTailer.poll();
      void this.mobileTailer.poll();
      void this.commitIfIdle();
    }, this.config.pollIntervalMs);
  }

  /** Para el watcher. Si no queda nada pendiente confirma la posicion de los logs; lo pendiente
   *  se descarta SIN confirmar, asi que se releera y reprocesara en el siguiente arranque. */
  async stop(): Promise<void> {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }
    const idle = this.isIdle();
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    for (const { timer } of this.retries.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.rutaRetries.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.retries.clear();
    this.rutaRetries.clear();
    if (idle) {
      await this.commitIfIdle(true);
    }
  }

  /** true si todo lo leido de los logs ya esta procesado (nada pendiente, en curso ni en reintento). */
  private isIdle(): boolean {
    return (
      this.pending.size === 0 &&
      this.inFlight.size === 0 &&
      this.retries.size === 0 &&
      this.rutaRetries.size === 0 &&
      this.activeRutas === 0
    );
  }

  /** Confirma (persiste) la posicion leida de ambos logs, solo si todo lo leido ya esta procesado.
   *  Ambos commit() se lanzan en el mismo tick que la comprobacion de reposo, para que un sondeo
   *  no pueda adelantar la posicion entre medias. */
  private async commitIfIdle(force = false): Promise<void> {
    if (!this.isIdle()) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastCommitAt < COMMIT_INTERVAL_MS) {
      return;
    }
    this.lastCommitAt = now;
    const results = await Promise.allSettled([this.luxTailer.commit(), this.mobileTailer.commit()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('No se pudo confirmar la posicion leida del log (se reintenta)', {
          operacion: 'watcher.commitError',
          resultado: 'ERROR',
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
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
        this.scheduleRefresh(
          { domain: 'recepcion', idAlbaran: event.idAlbaran, albaran: event.albaran, almacen: event.almacen, terminal: event.terminal },
          event.type,
        );
      } else {
        this.scheduleRefresh(
          { domain: 'expedicion', idPedido: event.idPedido, pedido: event.pedido, almacen: event.almacen, terminal: event.terminal },
          event.type,
        );
      }
    }
  }

  private async handleRutaEnviada(event: DetectedEvent): Promise<void> {
    this.activeRutas += 1;
    try {
      const pedidos = await resolverPedidosDeRuta(this.luxClient, event.idRuta as string, event.almacen);
      if (pedidos.length === 0) {
        this.logger.warn('Ruta enviada pero no se resolvio ningun pedido asociado', {
          operacion: 'watcher.rutaSinPedidos',
          resultado: 'ERROR',
          idRuta: event.idRuta,
        });
        // Aun sin pedidos, el envio queda registrado (la ruta estaba vacia en LUX al enviarla).
        await this.callSink(
          () =>
            this.sink.onRutaEnviadaSinPedidos?.({
              idRuta: event.idRuta as string,
              almacen: event.almacen,
              terminal: event.terminal,
              detectadoEn: new Date().toISOString(),
              pedidos: [],
            }),
          'ruta',
        );
        return;
      }
      for (const idPedido of pedidos) {
        this.scheduleRefresh({ domain: 'expedicion', idPedido, almacen: event.almacen, terminal: event.terminal }, 'rutaEnviada');
      }
    } catch (err) {
      const reintentara = isTransientLuxError(err);
      this.logger.error('No se pudo resolver los pedidos de la ruta enviada', {
        operacion: 'watcher.resolverRutaError',
        resultado: 'ERROR',
        idRuta: event.idRuta,
        reintentara,
        error: err instanceof Error ? err.message : String(err),
      });
      if (reintentara) {
        this.scheduleRutaRetry(event);
      }
    } finally {
      this.activeRutas -= 1;
    }
  }

  private scheduleRutaRetry(event: DetectedEvent): void {
    const idRuta = event.idRuta as string;
    if (this.rutaRetries.has(idRuta)) {
      return;
    }
    const timer = setTimeout(() => {
      this.rutaRetries.delete(idRuta);
      void this.handleRutaEnviada(event);
    }, this.config.retryDelayMs);
    this.rutaRetries.set(idRuta, timer);
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

    const now = Date.now();
    let existing = this.pending.get(key);
    if (!existing) {
      // Si este pedido tenia un reintento esperando, el evento nuevo lo absorbe (se refresca ya
      // con el debounce normal en vez de esperar al reintento).
      const retry = this.retries.get(key);
      if (retry) {
        clearTimeout(retry.timer);
        this.retries.delete(key);
        retry.firstAt = now;
        this.pending.set(key, retry);
        existing = retry;
      }
    }
    if (existing) {
      const entry = existing;
      clearTimeout(entry.timer);
      entry.motivos.add(motivo);
      entry.target = mergeTarget(entry.target, target);
      entry.timer = setTimeout(() => void this.refresh(key), this.delayFor(entry.firstAt, now));
      return;
    }
    const timer = setTimeout(() => void this.refresh(key), this.config.debounceMs);
    this.pending.set(key, { target, motivos: new Set([motivo]), timer, firstAt: now, attempts: 0 });
  }

  /** Espera hasta el refresco: el debounce normal, pero sin pasar de maxWaitMs desde la primera
   *  linea agrupada (con actividad continua el debounce deslizante no acotaria la latencia). */
  private delayFor(firstAt: number, now: number): number {
    return Math.max(0, Math.min(this.config.debounceMs, firstAt + this.config.maxWaitMs - now));
  }

  private refresh(key: string): Promise<void> {
    const entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry) {
      return Promise.resolve();
    }
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.runRefresh(key, entry));
    this.inFlight.set(key, run);
    void run.finally(() => {
      if (this.inFlight.get(key) === run) {
        this.inFlight.delete(key);
      }
    });
    return run;
  }

  private async runRefresh(key: string, entry: PendingRefresh): Promise<void> {
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
          almacen: entry.target.almacen,
          propietario: result.propietario,
          estado: result.estado,
          lineasCount: result.lineas.length,
          contenedoresCount: result.contenedores.length,
          motivos,
          duracionMs: Date.now() - startedAt,
        });
        const sinkOk = await this.callSink(
          () => this.sink.onExpedicionActualizada?.({ ...result, terminal: entry.target.terminal, motivos: motivosList }),
          'expedicion',
        );
        if (!sinkOk) {
          this.scheduleRetry(key, entry);
        }
      } else {
        const result = await this.refreshRecepcion(entry.target);
        this.logger.info('Albaran actualizado tras deteccion en log', {
          operacion: 'watcher.albaranActualizado',
          resultado: 'OK',
          idAlbaran: result.idAlbaran,
          albaran: result.albaran,
          almacen: entry.target.almacen,
          propietario: result.propietario,
          estado: result.estado,
          lineasCount: result.lineas.length,
          husCount: result.hus.length,
          motivos,
          duracionMs: Date.now() - startedAt,
        });
        const sinkOk = await this.callSink(
          () => this.sink.onAlbaranActualizado?.({ ...result, terminal: entry.target.terminal, motivos: motivosList }),
          'recepcion',
        );
        if (!sinkOk) {
          this.scheduleRetry(key, entry);
        }
      }
    } catch (err) {
      const reintentara = isTransientLuxError(err);
      this.logger.error('No se pudo re-consultar tras deteccion en log', {
        operacion: 'watcher.refreshError',
        resultado: 'ERROR',
        motivos,
        reintentara,
        error: err instanceof Error ? err.message : String(err),
      });
      if (reintentara) {
        this.scheduleRetry(key, entry);
      }
    }
  }

  /** Reintenta un refresco fallido por causa transitoria (con espera creciente). Mientras haya
   *  reintentos pendientes la posicion de los logs NO se confirma, asi no se pierde el evento. Si
   *  mientras tanto llego un evento nuevo del mismo pedido, se fusiona con ese (ya va a refrescar). */
  private scheduleRetry(key: string, entry: PendingRefresh): void {
    const newer = this.pending.get(key);
    if (newer) {
      for (const motivo of entry.motivos) {
        newer.motivos.add(motivo);
      }
      newer.target = mergeTarget(entry.target, newer.target);
      return;
    }
    if (this.retries.has(key)) {
      return;
    }
    entry.attempts += 1;
    const delay = Math.min(this.config.retryDelayMs * entry.attempts, MAX_RETRY_DELAY_MS);
    entry.timer = setTimeout(() => {
      this.retries.delete(key);
      entry.firstAt = Date.now();
      this.pending.set(key, entry);
      void this.refresh(key);
    }, delay);
    this.retries.set(key, entry);
  }

  /** Invoca el sink de persistencia (paso 3: guardar en destino AZA) sin dejar que un fallo ahi
   *  se confunda con un fallo de la re-consulta a LUX (que ya se registro por separado, arriba). */
  private async callSink(fn: () => Promise<void> | void, dominio: 'expedicion' | 'recepcion' | 'ruta'): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.logger.error('El sink de persistencia fallo tras un refresco correcto (el estado ya quedo registrado en el log anterior)', {
        operacion: 'watcher.sinkError',
        resultado: 'ERROR',
        dominio,
        reintentara: dominio !== 'ruta',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
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
      if (isTransientLuxError(err)) {
        throw err; // fallo de infraestructura: se reintenta todo el refresco, no se guarda incompleto
      }
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
    const { almacen } = target;
    const idPedidoDirecto = target.idPedido && target.idPedido !== '0' ? target.idPedido : undefined;
    let pedido = target.pedido;
    let cabecera: Expedicion | undefined;

    if (idPedidoDirecto) {
      cabecera = await this.expedicionesService.obtenerExpedicion(idPedidoDirecto, almacen);
      pedido = pedido ?? cabecera.pedido;
    }
    if (!pedido) {
      throw new Error('No se pudo determinar el numero de pedido para re-consultar (sin idPedido ni pedido)');
    }

    const resumen = await this.expedicionesService.obtenerResumenListadoExpedicion(pedido, almacen);
    const idPedido = idPedidoDirecto ?? resumen?.id;

    let lineas: ExpedicionLinea[] = [];
    let contenedores: ExpedicionContenedor[] = [];
    if (idPedido) {
      if (!cabecera) {
        cabecera = await this.fetchBestEffort(() => this.expedicionesService.obtenerExpedicion(idPedido, almacen), 'cabecera');
      }
      // Independientes entre si: en paralelo (antes, una tras otra).
      const [lineasRes, contenedoresRes] = await Promise.all([
        this.fetchBestEffort(() => this.expedicionesService.obtenerLineasExpedicion(idPedido, almacen), 'lineas'),
        this.fetchBestEffort(() => this.expedicionesService.obtenerContenedoresExpedicion(idPedido, almacen), 'contenedores'),
      ]);
      lineas = lineasRes ?? [];
      contenedores = contenedoresRes ?? [];
    }

    return {
      idPedido,
      pedido,
      almacen,
      propietario: resumen?.propietario,
      estado: resumen?.estado,
      cabecera,
      listado: resumen,
      lineas,
      contenedores,
    };
  }

  /** Re-consulta "completa" de una recepcion: cabecera (p_recCabeceraAza) + lineas
   *  (p_recAlbaranLineas) + HUs/pallets fisicos (p_recAlbaranHUPreinformado) -- equivalente de
   *  "contenedores" en expediciones, con forma de datos propia. */
  private async refreshRecepcion(
    target: Extract<PendingTarget, { domain: 'recepcion' }>,
  ): Promise<Omit<AlbaranActualizado, 'motivos'>> {
    const { almacen } = target;
    const idAlbaranDirecto = target.idAlbaran && target.idAlbaran !== '0' ? target.idAlbaran : undefined;
    let albaran = target.albaran;
    let cabecera: Recepcion | undefined;

    if (idAlbaranDirecto) {
      cabecera = await this.recepcionesService.obtenerRecepcion(idAlbaranDirecto, almacen);
      albaran = albaran ?? cabecera.albaran;
    }
    if (!albaran) {
      throw new Error('No se pudo determinar el numero de albaran para re-consultar (sin idAlbaran ni albaran)');
    }

    const resumen = await this.recepcionesService.obtenerResumenListadoRecepcion(albaran, almacen);
    const idAlbaran = idAlbaranDirecto ?? resumen?.id;

    let lineas: RecepcionLinea[] = [];
    let hus: RecepcionHU[] = [];
    if (idAlbaran) {
      if (!cabecera) {
        cabecera = await this.fetchBestEffort(() => this.recepcionesService.obtenerRecepcion(idAlbaran, almacen), 'cabecera');
      }
      const [lineasRes, husRes] = await Promise.all([
        this.fetchBestEffort(() => this.recepcionesService.obtenerLineasRecepcion(idAlbaran, almacen), 'lineas'),
        this.fetchBestEffort(() => this.recepcionesService.obtenerHUsRecepcion(idAlbaran, almacen), 'hus'),
      ]);
      lineas = lineasRes ?? [];
      hus = husRes ?? [];
    }

    return {
      idAlbaran,
      albaran,
      almacen,
      propietario: resumen?.propietario,
      estado: resumen?.estado,
      cabecera,
      listado: resumen,
      lineas,
      hus,
    };
  }
}
