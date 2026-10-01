import axios, { AxiosInstance, isAxiosError } from 'axios';
import type { AppConfig } from '../../config';
import type { Logger } from '../../logging';
import type { AuthManager } from '../../auth';
import { assertValidProcedureName } from '../procedures';
import { LuxFunctionalError, LuxHttpError, LuxNetworkError, LuxValidationError } from '../errors';
import type { ProcRequest, ProcResponse, ProcResponseRow } from '../models';

/**
 * Acciones de escritura de los procedimientos de LUX. Los reintentos automaticos del
 * LuxClient NUNCA se aplican a estas acciones: una vez la peticion sale hacia LUX, un timeout
 * o un 5xx no permiten saber con certeza si el procedimiento llego a ejecutarse en SQL Server
 * (no hay transacciones distribuidas ni idempotency-key documentados), así que reintentar
 * podria duplicar cabeceras/lineas. Ver docs/lux-api-analysis.md §12 y docs/architecture.md.
 */
const WRITE_ACTIONS = new Set(['ACTUALIZAR', 'INSERT', 'UPDATE']);

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;

export interface CallProcOptions {
  correlationId?: string;
  /** Metadato solo para logging (no se envia a LUX). */
  operacion?: string;
  /**
   * Almacen a enviar en la cabecera "Almacen" para ESTA llamada. Si no se indica, se usa el
   * almacen por defecto de la configuracion (config.luxWarehouse). Permite operar sobre varios
   * almacenes con el mismo usuario tecnico, tal como documenta LUX (ver
   * docs/lux-api-analysis.md §2.3): "El mismo usuario puede operar sobre distintos almacenes
   * cambiando la cabecera Almacen".
   */
  almacen?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capa exclusivamente responsable de hablar HTTP con LUX: headers, serializacion, timeout,
 * retry controlado, interpretacion de errores HTTP/funcionales. No conoce reglas de negocio
 * de AZA (no sabe que es una "expedicion").
 */
export class LuxClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthManager,
    private readonly logger: Logger,
    httpClient?: AxiosInstance,
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly retryBaseDelayMs: number = DEFAULT_RETRY_BASE_DELAY_MS,
  ) {
    this.http = httpClient ?? axios.create({
      baseURL: config.luxBaseUrl,
      timeout: config.luxTimeoutMs,
    });
  }

  /**
   * Ejecuta PUT /proc/{procedimiento} con `accion` + `params`.
   *
   * `params` nunca debe contener `usuario` ni `almacen` (se eliminan defensivamente si vinieran
   * incluidos por error del llamador, ver docs/lux-api-analysis.md §9).
   */
  async callProc(
    procedimiento: string,
    accion: string,
    params: ProcRequest = {},
    options: CallProcOptions = {},
  ): Promise<ProcResponse> {
    try {
      assertValidProcedureName(procedimiento);
    } catch (err) {
      throw new LuxValidationError(
        err instanceof Error ? err.message : 'Procedimiento invalido',
        { procedimiento },
        options.correlationId,
      );
    }

    const body: ProcRequest = { ...params, accion };
    delete body.usuario;
    delete body.almacen;

    const almacen = options.almacen ?? this.config.luxWarehouse;
    const isWrite = WRITE_ACTIONS.has(accion);
    const attemptsAllowed = isWrite ? 1 : this.maxRetries + 1;

    // Campos comunes a todos los logs de esta llamada.
    const logBase = {
      operacion: options.operacion,
      procedimiento,
      accion,
      almacen,
      correlationId: options.correlationId,
    };

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      const startedAt = Date.now();
      try {
        const token = await this.auth.getValidToken();
        const response = await this.http.put<ProcResponse>(`/proc/${procedimiento}`, body, {
          headers: {
            Authorization: `Bearer ${token}`,
            Almacen: almacen,
            'Content-Type': 'application/json',
          },
        });

        const rows = response.data ?? [];
        const first: ProcResponseRow | undefined = rows[0];
        const duracionMs = Date.now() - startedAt;

        if (first && typeof first.mensaje === 'string' && first.mensaje !== 'OK') {
          this.logger.info('Llamada LUX con error funcional', {
            ...logBase,
            resultado: 'ERROR',
            duracionMs,
            httpStatus: response.status,
            mensajeLux: first.mensaje,
            idPedido: first.idPedido,
            idAlbaran: first.idAlbaran,
          });
          throw new LuxFunctionalError(first.mensaje, first.campo, first.tab, options.correlationId);
        }

        this.logger.info('Llamada LUX correcta', {
          ...logBase,
          resultado: 'OK',
          duracionMs,
          httpStatus: response.status,
          mensajeLux: first?.mensaje,
          idPedido: first?.idPedido,
          idAlbaran: first?.idAlbaran,
        });
        return rows;
      } catch (err) {
        const duracionMs = Date.now() - startedAt;
        if (err instanceof LuxFunctionalError) {
          // Nunca reintentar errores funcionales.
          throw err;
        }

        const translated = this.translateError(err, options.correlationId);
        lastError = translated;

        const isTransient =
          translated instanceof LuxNetworkError ||
          (translated instanceof LuxHttpError && translated.isTransient);

        this.logger.warn('Llamada LUX fallida', {
          ...logBase,
          resultado: 'ERROR',
          duracionMs,
          httpStatus: translated instanceof LuxHttpError ? translated.status : undefined,
          attempt,
          isTransient,
          willRetry: isTransient && !isWrite && attempt < attemptsAllowed,
        });

        if (!isTransient || isWrite || attempt >= attemptsAllowed) {
          throw translated;
        }

        await sleep(this.retryBaseDelayMs * attempt);
      }
    }

    // Inalcanzable en la practica (el bucle siempre retorna o lanza), pero TypeScript
    // necesita un valor de retorno o lanzamiento explicito en todos los caminos.
    throw lastError ?? new Error('callProc: fallo desconocido');
  }

  private translateError(err: unknown, correlationId?: string): Error {
    if (isAxiosError(err)) {
      if (err.response) {
        return new LuxHttpError(
          `HTTP ${err.response.status} en /proc`,
          err.response.status,
          err.response.data,
          correlationId,
        );
      }
      return new LuxNetworkError('Error de red llamando a LUX', err, correlationId);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
