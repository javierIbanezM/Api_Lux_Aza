import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface StoppableServer {
  url: string;
  close: () => Promise<void>;
}

/** Levanta una app Express en un puerto efimero, para tests de integracion end-to-end. */
export async function startApp(app: Express): Promise<StoppableServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export interface JsonResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuesta HTTP de forma libre en tests
  body: any;
}

/** Cliente HTTP minimo (sin dependencias externas) para hablar con la app en tests. */
export function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = undefined;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Igual que `httpJson`, pero envia `rawBody` tal cual (sin `JSON.stringify`), util para tests
 * que necesitan mandar un cuerpo deliberadamente no-JSON (p.ej. verificar que `express.json()`
 * traduce el `SyntaxError` a un 400 en vez de un 500 generico).
 */
export function httpRaw(
  baseUrl: string,
  method: string,
  path: string,
  rawBody: string,
  headers?: Record<string, string>,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = undefined;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/**
 * Peticion HTTP de proposito general que devuelve tambien las cabeceras de respuesta (p.ej.
 * `set-cookie`, `location`) y el cuerpo como texto sin parsear. Pensada para los tests de la
 * interfaz web (/almacen/*), que necesitan inspeccionar cookies de sesion y redirecciones, no
 * solo cuerpos JSON como `httpJson`/`httpRaw`.
 */
export function httpRequest(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const { body, headers } = options;
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
