import { describe, expect, it } from 'vitest';
import { formatDateForLux, isValidLuxDateString, parseDateFromLux } from '../../src/lux/utils/dateFormatter';

describe('dateFormatter', () => {
  it('convierte un Date a dd/MM/yyyy', () => {
    const date = new Date(2026, 7, 15); // 15/08/2026 (mes 0-indexado)
    expect(formatDateForLux(date)).toBe('15/08/2026');
  });

  it('rellena con ceros dias y meses de un digito', () => {
    const date = new Date(2026, 0, 5); // 05/01/2026
    expect(formatDateForLux(date)).toBe('05/01/2026');
  });

  it('lanza al formatear una fecha invalida', () => {
    expect(() => formatDateForLux(new Date('no-es-fecha'))).toThrow();
  });

  it('parsea dd/MM/yyyy a Date correctamente', () => {
    const date = parseDateFromLux('15/08/2026');
    expect(date).not.toBeNull();
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(7);
    expect(date!.getDate()).toBe(15);
  });

  it('devuelve null al parsear una cadena vacia (NULL de LUX)', () => {
    expect(parseDateFromLux('')).toBeNull();
  });

  it('lanza al parsear un formato invalido', () => {
    expect(() => parseDateFromLux('2026-08-15')).toThrow();
  });

  it('lanza al parsear una fecha inexistente (31/02)', () => {
    expect(() => parseDateFromLux('31/02/2026')).toThrow();
  });

  it('isValidLuxDateString acepta vacio y formato correcto, rechaza el resto', () => {
    expect(isValidLuxDateString('')).toBe(true);
    expect(isValidLuxDateString('15/08/2026')).toBe(true);
    expect(isValidLuxDateString('15-08-2026')).toBe(false);
    expect(isValidLuxDateString('31/02/2026')).toBe(false);
  });
});
