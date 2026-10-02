import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const base = {
  LUX_BASE_URL: 'http://lux',
  LUX_USERNAME: 'u',
  LUX_PASSWORD: 'p',
  LUX_WAREHOUSE: 'SAGUNTO',
  AZA_API_KEY: 'k',
  SESSION_SECRET: 's',
};

describe('config/env SESSION_COOKIE_SECURE', () => {
  it('por defecto es true en produccion y false en el resto', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).sessionCookieSecure).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).sessionCookieSecure).toBe(false);
    expect(loadConfig({ ...base }).sessionCookieSecure).toBe(false);
  });

  it('SESSION_COOKIE_SECURE=false lo desactiva incluso en produccion (acceso por HTTP)', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }).sessionCookieSecure).toBe(false);
  });

  it('SESSION_COOKIE_SECURE=true lo fuerza y un valor invalido falla al arrancar', () => {
    expect(loadConfig({ ...base, SESSION_COOKIE_SECURE: 'true' }).sessionCookieSecure).toBe(true);
    expect(() => loadConfig({ ...base, SESSION_COOKIE_SECURE: 'quizas' })).toThrow(/SESSION_COOKIE_SECURE/);
  });
});
