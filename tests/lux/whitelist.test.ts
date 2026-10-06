import { describe, expect, it } from 'vitest';
import { assertValidProcedureName, isWhitelistedProcedure, PROCEDURE_WHITELIST } from '../../src/lux/procedures';

describe('whitelist de procedimientos', () => {
  it('contiene exactamente los 12 procedimientos autorizados', () => {
    expect([...PROCEDURE_WHITELIST].sort()).toEqual(
      [
        'p_expCabeceraAza',
        'p_expPedidoLineas',
        'p_expedicionesAza',
        'p_expPedidoContenedores',
        'p_expRutasDetalle',
        'p_expRutasDeca',
        'p_expRutas',
        'p_manReferenciasADR',
        'p_recCabeceraAza',
        'p_recAlbaranLineas',
        'p_recepcionesAza',
        'p_recAlbaranHUPreinformado',
      ].sort(),
    );
  });

  it('acepta p_recAlbaranHUPreinformado (confirmado contra el servidor real, equivalente de contenedores para recepciones)', () => {
    expect(isWhitelistedProcedure('p_recAlbaranHUPreinformado')).toBe(true);
  });

  it('acepta un procedimiento valido', () => {
    expect(isWhitelistedProcedure('p_expCabeceraAza')).toBe(true);
    expect(() => assertValidProcedureName('p_expCabeceraAza')).not.toThrow();
  });

  it('acepta p_expPedidoContenedores (confirmado contra el servidor real, no viene del PDF)', () => {
    expect(isWhitelistedProcedure('p_expPedidoContenedores')).toBe(true);
  });

  it('acepta p_expRutasDeca (DECA de rutas, solo lectura, usado por el watcher)', () => {
    expect(isWhitelistedProcedure('p_expRutasDeca')).toBe(true);
  });

  it('acepta p_expRutasDetalle (confirmado contra el log real, usado por el watcher)', () => {
    expect(isWhitelistedProcedure('p_expRutasDetalle')).toBe(true);
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
