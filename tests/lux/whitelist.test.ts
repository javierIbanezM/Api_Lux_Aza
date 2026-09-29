import { describe, expect, it } from 'vitest';
import { assertValidProcedureName, isWhitelistedProcedure, PROCEDURE_WHITELIST } from '../../src/lux/procedures';

describe('whitelist de procedimientos', () => {
  it('contiene exactamente los 7 procedimientos autorizados', () => {
    expect([...PROCEDURE_WHITELIST].sort()).toEqual(
      [
        'p_expCabeceraAza',
        'p_expPedidoLineas',
        'p_expedicionesAza',
        'p_expPedidoContenedores',
        'p_recCabeceraAza',
        'p_recAlbaranLineas',
        'p_recepcionesAza',
      ].sort(),
    );
  });

  it('acepta un procedimiento valido', () => {
    expect(isWhitelistedProcedure('p_expCabeceraAza')).toBe(true);
    expect(() => assertValidProcedureName('p_expCabeceraAza')).not.toThrow();
  });

  it('acepta p_expPedidoContenedores (confirmado contra el servidor real, no viene del PDF)', () => {
    expect(isWhitelistedProcedure('p_expPedidoContenedores')).toBe(true);
  });

  it('rechaza un procedimiento que no empieza por p_', () => {
    expect(isWhitelistedProcedure('exec_dangerous')).toBe(false);
    expect(() => assertValidProcedureName('exec_dangerous')).toThrow(/p_/);
  });

  it('rechaza un procedimiento con prefijo p_ pero fuera de whitelist', () => {
    expect(isWhitelistedProcedure('p_otroProcedimiento')).toBe(false);
    expect(() => assertValidProcedureName('p_otroProcedimiento')).toThrow(/no autorizado/);
  });
});
