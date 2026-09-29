import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Servidor HTTP mock de LUX, usable tanto por tests unitarios (auth, LuxClient) como de
 * integracion (flujos completos de servicios). Permite simular:
 *   - /login (200 OK / 401)
 *   - /login/refreshToken (200 OK / 401)
 *   - PUT /proc/{procedimiento} (200 con mensaje OK, 200 con mensaje ERR_*, 400, 401, 403, 404,
 *     500, timeout)
 */
export interface MockLoginResponse {
  name: string;
  token: string;
  refreshToken: string;
  issuedAt: string;
  expiresAt: string;
  permisos: string[];
}

type MockResult = { status: number; body: unknown } | 'timeout';

export type ProcHandler = (
  procedimiento: string,
  body: Record<string, string>,
  headers: IncomingMessage['headers'],
) => MockResult | Promise<MockResult>;

export interface LuxMockServerOptions {
  /** Credenciales validas para /login. Cualquier otra combinacion devuelve 401. */
  validCredentials?: { username: string; password: string };
  /** Token(es) validos para llamadas de datos. Si no se define, cualquier Bearer no vacio vale. */
  validTokens?: string[];
  /** Respuesta a devolver en login correcto (permite forzar expiresAt para tests de expiracion). */
  loginResponse?: () => MockLoginResponse;
  /** Handler de refresh: recibe el refreshToken recibido, devuelve la respuesta o null (401). */
  onRefresh?: (refreshToken: string) => MockResult | Promise<MockResult>;
  /** Handler de /proc/{procedimiento}: define el comportamiento de cada llamada. */
  onProc?: ProcHandler;
}

export class LuxMockServer {
  private server: http.Server;
  private options: LuxMockServerOptions;
  public callLog: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: IncomingMessage['headers'];
  }> = [];

  constructor(options: LuxMockServerOptions = {}) {
    this.options = {
      validCredentials: { username: 'usuarioAPI', password: 'secret' },
      ...options,
    };
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  updateOptions(partial: Partial<LuxMockServerOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, string>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const body = await this.readBody(req);
    this.callLog.push({ method, path: url, body, headers: req.headers });

    if (method === 'POST' && url === '/login') {
      const creds = this.options.validCredentials!;
      if (body.username === creds.username && body.password === creds.password) {
        const response: MockLoginResponse = this.options.loginResponse
          ? this.options.loginResponse()
          : {
              name: creds.username,
              token: 'mock-jwt-token',
              refreshToken: 'mock-refresh-token',
              issuedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              permisos: ['web'],
            };
        this.send(res, 200, response);
        return;
      }
      this.send(res, 401, { mensaje: 'Credenciales incorrectas' });
      return;
    }

    if (method === 'POST' && url === '/login/refreshToken') {
      const refreshToken = body.refreshToken as string | undefined;
      if (this.options.onRefresh && refreshToken) {
        const result = await this.options.onRefresh(refreshToken);
        if (result === 'timeout') {
          return; // no responder nunca -> el cliente hara timeout
        }
        this.send(res, result.status, result.body);
        return;
      }
      this.send(res, 401, { mensaje: 'refreshToken invalido' });
      return;
    }

    const procMatch = /^\/proc\/([^/]+)$/.exec(url);
    if (method === 'PUT' && procMatch) {
      const procedimiento = decodeURIComponent(procMatch[1] as string);

      if (!procedimiento.startsWith('p_')) {
        this.send(res, 403, { mensaje: 'Procedimiento no permitido' });
        return;
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.length <= 7) {
        this.send(res, 401, { mensaje: 'No autenticado' });
        return;
      }
      const token = authHeader.slice('Bearer '.length);
      if (this.options.validTokens && !this.options.validTokens.includes(token)) {
        this.send(res, 401, { mensaje: 'Token invalido o expirado' });
        return;
      }

      if (!req.headers.almacen) {
        this.send(res, 400, { mensaje: 'Falta cabecera Almacen' });
        return;
      }

      if (this.options.onProc) {
        const result = await this.options.onProc(procedimiento, body, req.headers);
        if (result === 'timeout') {
          return; // no responder -> timeout en el cliente
        }
        this.send(res, result.status, result.body);
        return;
      }

      this.send(res, 200, [{ mensaje: 'OK' }]);
      return;
    }

    this.send(res, 404, { mensaje: 'No encontrado' });
  }
}
