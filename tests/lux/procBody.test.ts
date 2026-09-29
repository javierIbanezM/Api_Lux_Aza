import { describe, expect, it } from 'vitest';
import { buildProcBody } from '../../src/lux/utils/procBody';

describe('buildProcBody — semantica de datos extra', () => {
  it('no incluye claves cuyo valor es undefined (no enviado -> no tocar)', () => {
    const body = buildProcBody({ idAlbaran: '3012', matricula: undefined });
    expect(body).toEqual({ idAlbaran: '3012' });
    expect('matricula' in body).toBe(false);
  });

  it('no incluye claves cuyo valor es null (no enviado -> no tocar)', () => {
    const body = buildProcBody({ idAlbaran: '3012', matricula: null });
    expect(body).toEqual({ idAlbaran: '3012' });
    expect('matricula' in body).toBe(false);
  });

  it('incluye la clave con "" cuando se pasa explicitamente (borrar valor)', () => {
    const body = buildProcBody({ idAlbaran: '3012', matricula: '' });
    expect(body).toEqual({ idAlbaran: '3012', matricula: '' });
  });

  it('incluye la clave con el valor dado (fijar valor)', () => {
    const body = buildProcBody({ idAlbaran: '3012', matricula: '1234ABC' });
    expect(body).toEqual({ idAlbaran: '3012', matricula: '1234ABC' });
  });

  it('convierte numeros y booleanos a string sin reformatear', () => {
    const body = buildProcBody({ cantidadPedida: 24, bloqueo: false });
    expect(body).toEqual({ cantidadPedida: '24', bloqueo: 'false' });
  });

  it('nunca produce un body con usuario/almacen si no se le pasan explicitamente', () => {
    const body = buildProcBody({ accion: 'ACTUALIZAR', idPedido: '0' });
    expect(body).not.toHaveProperty('usuario');
    expect(body).not.toHaveProperty('almacen');
  });
});
