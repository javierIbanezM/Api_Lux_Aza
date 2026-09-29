import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager } from '../../src/auth';
import { createLogger } from '../../src/logging';
import { LuxAuthError } from '../../src/lux/errors';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

describe('AuthManager', () => {
  let mock: LuxMockServer;
  let baseUrl: string;

  beforeEach(async () => {
    mock = new LuxMockServer();
    baseUrl = await mock.listen();
  });

  afterEach(async () => {
    await mock.close();
  });

  it('login correcto obtiene y cachea el token', async () => {
    const config = buildTestConfig({ luxBaseUrl: baseUrl });
    const auth = new AuthManager(config, createLogger('error'));

    const token = await auth.login();

    expect(token).toBe('mock-jwt-token');
    expect(auth.hasSession()).toBe(true);
    expect(auth.getSessionStatus().authenticated).toBe(true);
  });

  it('parsea correctamente expiresAt en el formato real de LUX (ZonedDateTime con sufijo [UTC])', async () => {
    // Formato confirmado contra el servidor real de LUX: ISO-8601 con un sufijo "[UTC]" que
    // Date.parse (ECMA-262) no reconoce por si solo. Si no se normaliza, la sesion se trataria
    // como expirada de inmediato y forzaria un refresh en cada peticion.
    mock.updateOptions({
      loginResponse: () => ({
        name: 'interfaz',
        token: 'token-real',
        refreshToken: 'refresh-real',
        issuedAt: '2026-09-29T12:45:23.081Z[UTC]',
        expiresAt: '2026-10-09T12:45:23.081Z[UTC]',
        permisos: ['web'],
      }),
    });

    const config = buildTestConfig({ luxBaseUrl: baseUrl, luxRefreshMarginMs: 60_000 });
    const auth = new AuthManager(config, createLogger('error'));

    const token = await auth.getValidToken();
    expect(token).toBe('token-real');

    const status = auth.getSessionStatus();
    expect(status.authenticated).toBe(true);
    expect(status.expiresAt).toBe('2026-10-09T12:45:23.081Z');

    // Una segunda llamada inmediata no debe disparar refresh: la sesion esta lejos de expirar.
    const second = await auth.getValidToken();
    expect(second).toBe('token-real');
  });

  it('login incorrecto lanza LuxAuthError y no deja sesion', async () => {
    const config = buildTestConfig({ luxBaseUrl: baseUrl, luxPassword: 'password-incorrecto' });
    const auth = new AuthManager(config, createLogger('error'));

    await expect(auth.login()).rejects.toBeInstanceOf(LuxAuthError);
    expect(auth.hasSession()).toBe(false);
  });

  it('getValidToken refresca el token cuando esta a punto de expirar', async () => {
    let refreshCalls = 0;
    mock.updateOptions({
      loginResponse: () => ({
        name: 'usuarioAPI',
        token: 'token-inicial',
        refreshToken: 'refresh-inicial',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 100).toISOString(), // expira casi de inmediato
        permisos: ['web'],
      }),
      onRefresh: (refreshToken) => {
        refreshCalls += 1;
        expect(refreshToken).toBe('refresh-inicial');
        return {
          status: 200,
          body: {
            token: 'token-refrescado',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      },
    });

    const config = buildTestConfig({ luxBaseUrl: baseUrl, luxRefreshMarginMs: 60_000 });
    const auth = new AuthManager(config, createLogger('error'));

    const first = await auth.getValidToken();
    expect(first).toBe('token-inicial');

    const second = await auth.getValidToken();
    expect(second).toBe('token-refrescado');
    expect(refreshCalls).toBe(1);
  });

  it('refresh fallido fuerza un nuevo login', async () => {
    let loginCalls = 0;
    mock.updateOptions({
      loginResponse: () => {
        loginCalls += 1;
        return {
          name: 'usuarioAPI',
          token: `token-login-${loginCalls}`,
          refreshToken: 'refresh-token',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 100).toISOString(),
          permisos: ['web'],
        };
      },
      onRefresh: () => ({ status: 401, body: { mensaje: 'refreshToken expirado' } }),
    });

    const config = buildTestConfig({ luxBaseUrl: baseUrl, luxRefreshMarginMs: 60_000 });
    const auth = new AuthManager(config, createLogger('error'));

    const first = await auth.getValidToken();
    expect(first).toBe('token-login-1');

    const second = await auth.getValidToken();
    expect(second).toBe('token-login-2');
    expect(loginCalls).toBe(2);
  });

  it('no realiza refresh concurrente: varias llamadas simultaneas comparten un unico refresh', async () => {
    let refreshCalls = 0;
    mock.updateOptions({
      loginResponse: () => ({
        name: 'usuarioAPI',
        token: 'token-inicial',
        refreshToken: 'refresh-inicial',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 50).toISOString(),
        permisos: ['web'],
      }),
      onRefresh: async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          status: 200,
          body: { token: 'token-refrescado', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
        };
      },
    });

    const config = buildTestConfig({ luxBaseUrl: baseUrl, luxRefreshMarginMs: 60_000 });
    const auth = new AuthManager(config, createLogger('error'));

    await auth.getValidToken(); // login inicial

    const results = await Promise.all([
      auth.getValidToken(),
      auth.getValidToken(),
      auth.getValidToken(),
    ]);

    expect(results).toEqual(['token-refrescado', 'token-refrescado', 'token-refrescado']);
    expect(refreshCalls).toBe(1);
  });
});
