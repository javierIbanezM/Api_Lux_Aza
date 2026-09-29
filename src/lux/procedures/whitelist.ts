/**
 * Whitelist de procedimientos almacenados que la integracion de AZA puede invocar via /proc.
 *
 * Fuente: docs/lux-api-analysis.md §11. Cualquier otro nombre debe rechazarse ANTES de llamar a
 * LUX, independientemente de que LUX ya valide el prefijo `p_` y devuelva 403 por su cuenta.
 *
 * `p_expPedidoContenedores` es una excepcion: no viene del PDF del proveedor, se anadio tras
 * confirmar su existencia y comportamiento (solo SELECT_INICIO) contra el servidor real de LUX,
 * ver docs/lux-api-analysis.md §14.
 */
export const PROCEDURE_WHITELIST = [
  'p_expCabeceraAza',
  'p_expPedidoLineas',
  'p_expedicionesAza',
  'p_expPedidoContenedores',
  'p_recCabeceraAza',
  'p_recAlbaranLineas',
  'p_recepcionesAza',
] as const;

export type WhitelistedProcedure = (typeof PROCEDURE_WHITELIST)[number];

export function isWhitelistedProcedure(name: string): name is WhitelistedProcedure {
  return (PROCEDURE_WHITELIST as readonly string[]).includes(name);
}

export function assertValidProcedureName(name: string): asserts name is WhitelistedProcedure {
  if (!name.startsWith('p_')) {
    throw new Error(`Nombre de procedimiento invalido (debe empezar por 'p_'): ${name}`);
  }
  if (!isWhitelistedProcedure(name)) {
    throw new Error(`Procedimiento no autorizado (no esta en la whitelist): ${name}`);
  }
}
