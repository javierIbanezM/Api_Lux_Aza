import { describe, expect, it } from 'vitest';
import { isValidWarehouse, WAREHOUSES } from '../../src/lux/warehouses';

describe('lux/warehouses', () => {
  it('contiene los 5 almacenes conocidos', () => {
    expect([...WAREHOUSES].sort()).toEqual(
      ['SAGUNTO', 'CHESTECM', 'ALMUSSAFES', 'MONTAVERNER', 'CHESTE'].sort(),
    );
  });

  it('isValidWarehouse acepta un almacen conocido y rechaza uno desconocido', () => {
    expect(isValidWarehouse('SAGUNTO')).toBe(true);
    expect(isValidWarehouse('CHESTE')).toBe(true);
    expect(isValidWarehouse('OTRO_ALMACEN')).toBe(false);
    expect(isValidWarehouse('')).toBe(false);
  });
});
