import type { AppConfig } from '../../src/config';

/** Config de pruebas: apunta al mock de LUX levantado en cada test. */
export function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    luxBaseUrl: 'http://127.0.0.1:0',
    luxUsername: 'usuarioAPI',
    luxPassword: 'secret',
    luxWarehouse: 'ALM01',
    luxTimeoutMs: 2000,
    luxRefreshMarginMs: 60_000,
    luxCatalogCacheTtlMs: 60_000,
    logLevel: 'error',
    port: 0,
    nodeEnv: 'test',
    azaApiKey: 'test-api-key',
    sessionSecret: 'test-session-secret',
    sessionCookieSecure: false,
    ...overrides,
  };
}
