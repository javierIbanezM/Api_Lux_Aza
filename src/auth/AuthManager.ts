import axios, { AxiosInstance, isAxiosError } from 'axios';
import type { AppConfig } from '../config';
import type { Logger } from '../logging';
import { LuxAuthError, LuxNetworkError } from '../lux/errors';
import type {
  LoginResponse,
  RefreshTokenResponse,
} from '../lux/models';

interface Session {
  token: string;
  refreshToken: string;
  /** epoch ms; si no se pudo parsear expiresAt, se pone a Date.now() (fuerza refresh inmediato) */
  expiresAtMs: number;
}

/**
 * Mantiene un JWT valido para hablar con LUX.
 *
 * Responsabilidad unica: login, cache del token con expiry+margen, refresh con mutex
 * anti-concurrencia. Nunca loguea password/token/refreshToken.
 */
export class AuthManager {
  private readonly http: AxiosInstance;
  private session: Session | undefined;
  private refreshInFlight: Promise<string> | undefined;
  private loginInFlight: Promise<string> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    httpClient?: AxiosInstance,
  ) {
    this.http = httpClient ?? axios.create({
      baseURL: config.luxBaseUrl,
      timeout: config.luxTimeoutMs,
    });
  }

  /** true si hay una sesion en memoria (no implica que siga vigente). */
  hasSession(): boolean {
    return this.session !== undefined;
  }

  /** Estado no sensible de la sesion, util para health checks. Nunca incluye el token. */
  getSessionStatus(): { authenticated: boolean; expiresAt?: string } {
    if (!this.session) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      expiresAt: new Date(this.session.expiresAtMs).toISOString(),
    };
  }

  /**
   * Devuelve un token valido: usa el de cache si no esta a punto de expirar; si esta a punto
   * de expirar, intenta refresh; si no hay sesion, hace login.
   */
  async getValidToken(): Promise<string> {
    if (!this.session) {
      return this.login();
    }
    const now = Date.now();
    if (now + this.config.luxRefreshMarginMs < this.session.expiresAtMs) {
      return this.session.token;
    }
    try {
      return await this.refresh();
    } catch {
      this.logger.warn('Refresh de token fallido, forzando nuevo login', {
        operacion: 'auth.refresh',
        resultado: 'ERROR',
      });
      this.session = undefined;
      return this.login();
    }
  }

  /**
   * Login contra LUX. Igual que `refresh`, solo uno puede estar en curso a la vez: si llegan
   * varias peticiones simultaneas sin sesion (arranque en frio, tras un fallo de refresh),
   * comparten el mismo login en vez de lanzar uno por peticion.
   */
  login(): Promise<string> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    return this.loginInFlight;
  }

  private async doLogin(): Promise<string> {
    try {
      const response = await this.http.post<LoginResponse>('/login', {
        username: this.config.luxUsername,
        password: this.config.luxPassword,
      });
      const data = response.data;
      this.session = {
        token: data.token,
        refreshToken: data.refreshToken,
        expiresAtMs: this.parseExpiry(data.expiresAt),
      };
      this.logger.info('Login LUX correcto', {
        operacion: 'auth.login',
        resultado: 'OK',
        httpStatus: response.status,
      });
      return this.session.token;
    } catch (err) {
      this.session = undefined;
      throw this.toAuthOrNetworkError(err, 'login');
    }
  }

  /**
   * Refresca el token vigente. Solo un refresh puede estar en curso a la vez: llamadas
   * concurrentes reutilizan la misma promesa (mutex en memoria).
   */
  async refresh(): Promise<string> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    if (!this.session) {
      throw new LuxAuthError('No hay sesion activa para refrescar');
    }
    this.refreshInFlight = this.doRefresh(this.session.refreshToken).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    try {
      const response = await this.http.post<RefreshTokenResponse>('/login/refreshToken', {
        refreshToken,
      });
      const data = response.data;
      const previous = this.session;
      this.session = {
        token: data.token,
        // TODO — INFORMACION NO DEFINIDA EN LA DOCUMENTACION: si la respuesta no trae un nuevo
        // refreshToken, se reutiliza el anterior (comportamiento habitual en refresh rotativo).
        refreshToken: data.refreshToken ?? previous?.refreshToken ?? refreshToken,
        expiresAtMs: data.expiresAt ? this.parseExpiry(data.expiresAt) : Date.now(),
      };
      this.logger.info('Refresh de token LUX correcto', {
        operacion: 'auth.refresh',
        resultado: 'OK',
        httpStatus: response.status,
      });
      return this.session.token;
    } catch (err) {
      this.session = undefined;
      throw this.toAuthOrNetworkError(err, 'refresh');
    }
  }

  private parseExpiry(expiresAt: string): number {
    // LUX devuelve issuedAt/expiresAt en formato java.time.ZonedDateTime, p.ej.
    // "2026-10-09T12:45:23.081Z[UTC]": ISO-8601 valido seguido de un sufijo "[ZoneId]" que
    // Date.parse (ECMA-262) no reconoce y hace fallar el parseo. Confirmado contra el servidor
    // real de LUX (ver docs/progress.md). Se elimina ese sufijo antes de parsear.
    const iso = expiresAt.replace(/\[[^[\]]*\]$/, '');
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) {
      // Si aun asi no es parseable (formato inesperado no visto hasta ahora), se trata como ya
      // expirado para forzar refresh/login en el proximo uso en vez de asumir una sesion valida
      // indefinidamente.
      this.logger.warn('expiresAt de LUX no parseable, se asume expirado', {
        operacion: 'auth.parseExpiry',
        resultado: 'ERROR',
      });
      return Date.now();
    }
    return parsed;
  }

  private toAuthOrNetworkError(err: unknown, phase: 'login' | 'refresh'): Error {
    if (isAxiosError(err)) {
      if (err.response) {
        this.logger.error(`Fallo de autenticacion LUX (${phase})`, {
          operacion: `auth.${phase}`,
          resultado: 'ERROR',
          httpStatus: err.response.status,
        });
        return new LuxAuthError(`Fallo de autenticacion LUX (${phase}): HTTP ${err.response.status}`);
      }
      this.logger.error(`Error de red hablando con LUX (${phase})`, {
        operacion: `auth.${phase}`,
        resultado: 'ERROR',
      });
      return new LuxNetworkError(`Error de red en ${phase} contra LUX`, err);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
