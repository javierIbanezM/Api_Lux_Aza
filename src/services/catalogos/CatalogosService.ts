import type { LuxClient } from '../../lux/client';

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

/**
 * Catalogos de valores de LUX (docs/lux-api-analysis.md §6, §7, §9).
 *
 * Se cachean en memoria con un TTL corto configurable (nunca indefinido, ver §40 de las
 * instrucciones) porque son datos maestros que cambian con poca frecuencia pero SI pueden
 * cambiar en Whales (nuevos transportistas, service levels, etc.).
 *
 * Cada metodo acepta un `almacen` opcional (algunos catalogos, como transportistas o
 * propietarios, pueden variar de un almacen a otro): la clave de cache incluye el almacen para
 * no devolver el catalogo de un almacen distinto al pedido.
 */
export class CatalogosService {
  private readonly cache = new Map<string, CacheEntry<Record<string, string>[]>>();
  /** Cargas en curso por clave: varias peticiones simultaneas con la cache vacia/expirada
   *  comparten una sola llamada a LUX en vez de lanzar una cada una. */
  private readonly inFlight = new Map<string, Promise<Record<string, string>[]>>();

  constructor(
    private readonly luxClient: LuxClient,
    private readonly ttlMs: number,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('CatalogosService: ttlMs debe ser un numero positivo (cache nunca indefinida)');
    }
  }

  private async getCached(
    key: string,
    almacen: string | undefined,
    loader: () => Promise<Record<string, string>[]>,
  ): Promise<Record<string, string>[]> {
    const cacheKey = `${key}:${almacen ?? 'default'}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.value;
    }
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }
    const load = loader()
      .then((value) => {
        this.cache.set(cacheKey, { value, expiresAtMs: now + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, load);
    return load;
  }

  /** Invalida toda la cache de catalogos (util tras cambios conocidos en Whales o en tests). */
  clearCache(): void {
    this.cache.clear();
  }

  selectCargas(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('SELECT_CARGAS', almacen, () =>
      this.luxClient.callProc('p_expCabeceraAza', 'SELECT_CARGAS', {}, {
        operacion: 'catalogos.selectCargas',
        almacen,
      }),
    );
  }

  selectServiceLevel(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('SELECT_SERVICE_LEVEL', almacen, () =>
      this.luxClient.callProc('p_expCabeceraAza', 'SELECT_SERVICE_LEVEL', {}, {
        operacion: 'catalogos.selectServiceLevel',
        almacen,
      }),
    );
  }

  /**
   * Zonas de descarga validas para un propietario (p_recCabeceraAza, accion=SELECT_DESCARGAS).
   * El PDF del proveedor no aclara si `propietario` es obligatorio; se acepta como parametro
   * opcional porque un ejemplo de uso real aportado por el usuario lo incluye
   * (`{"accion":"SELECT_DESCARGAS","propietario":"..."}`), ver docs/lux-api-analysis.md §15.
   * La cache es por almacen + propietario (los resultados pueden variar segun el propietario).
   */
  selectDescargas(propietario?: string, almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached(`SELECT_DESCARGAS:${propietario ?? 'sin-propietario'}`, almacen, () =>
      this.luxClient.callProc('p_recCabeceraAza', 'SELECT_DESCARGAS', propietario ? { propietario } : {}, {
        operacion: 'catalogos.selectDescargas',
        almacen,
      }),
    );
  }

  selectTransportistas(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('select_transportistas', almacen, () =>
      this.luxClient.callProc('p_expCabeceraAza', 'select_transportistas', {}, {
        operacion: 'catalogos.selectTransportistas',
        almacen,
      }),
    );
  }

  selectPropietarios(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('select_propietarios', almacen, () =>
      this.luxClient.callProc('p_expCabeceraAza', 'select_propietarios', {}, {
        operacion: 'catalogos.selectPropietarios',
        almacen,
      }),
    );
  }

  selectTipos(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('select_tipos', almacen, () =>
      this.luxClient.callProc('p_expCabeceraAza', 'select_tipos', {}, {
        operacion: 'catalogos.selectTipos',
        almacen,
      }),
    );
  }

  /**
   * Estados de pedido (para filtro `estado` de expediciones). La documentacion solo confirma
   * esta accion sobre p_expedicionesAza (ver §6.3).
   * TODO — INFORMACION NO DEFINIDA EN LA DOCUMENTACION: no se confirma una accion equivalente
   * documentada explicitamente para el listado de recepciones (p_recepcionesAza).
   */
  pedidoEstado(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('pedido_estado', almacen, () =>
      this.luxClient.callProc('p_expedicionesAza', 'pedido_estado', {}, {
        operacion: 'catalogos.pedidoEstado',
        almacen,
      }),
    );
  }

  pedidoTipos(almacen?: string): Promise<Record<string, string>[]> {
    return this.getCached('pedido_tipos', almacen, () =>
      this.luxClient.callProc('p_expedicionesAza', 'pedido_tipos', {}, {
        operacion: 'catalogos.pedidoTipos',
        almacen,
      }),
    );
  }
}
