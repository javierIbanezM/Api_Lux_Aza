/**
 * Whitelist de procedimientos almacenados que la integracion de AZA puede invocar via /proc.
 *
 * Fuente: docs/lux-api-analysis.md §11. Cualquier otro nombre debe rechazarse ANTES de llamar a
 * LUX, independientemente de que LUX ya valide el prefijo `p_` y devuelva 403 por su cuenta.
 *
 * `p_expPedidoContenedores` es una excepcion: no viene del PDF del proveedor, se anadio tras
 * confirmar su existencia y comportamiento (solo SELECT_INICIO) contra el servidor real de LUX,
 * ver docs/lux-api-analysis.md §14.
 *
 * `p_expRutasDetalle` tambien es una excepcion, anadida para el watcher de logs (src/watcher/):
 * resuelve que pedidos lleva una ruta de transporte (accion=SELECT, idParent=<idRuta>). Confirmado
 * contra el log real de LUX, ver docs/lux-api-analysis.md §16. Solo lectura, no expuesto por
 * ningun endpoint de /api/*.
 *
 * `p_expRutasDeca` (DECA de rutas, dato aportado por el proveedor, no esta en el PDF): acciones
 * SELECT (se le pasa un `id` o un `numeroRuta`) y SELECT_ENVIOS (todos los eventos/envios de la
 * ruta). Solo lectura; lo usa el watcher de logs (src/watcher/) cuando alguien consulta una ruta.
 *
 * `p_expRutas` (la ruta en si: conductor, DNI, telefono, matriculas, transportista, estado...): solo
 * accion SELECT con `numeroRuta` EXACTO, solo lectura. Se usa para completar el detalle de una
 * expedicion con los datos de su ruta (conductorNombre, conductorDni, matriculaTractora...).
 *
 * `p_manReferenciasADR` (clasificacion ADR de cada referencia: campo `adr` = 'NO APLICA' | 'ADR' | 'LQ'):
 * solo lectura (SELECT con adr='LQ'/'ADR' para listar las referencias peligrosas). Se usa para saber si
 * un pedido tiene peligrosidad (al menos una referencia ADR o LQ).
 *
 * `p_recAlbaranHUPreinformado` es el equivalente de `p_expPedidoContenedores` pero para
 * recepciones (detalle por HU/pallet fisico, no por linea de albaran): confirmado contra el
 * servidor real (accion=SELECT_INICIO, idParent=<idAlbaran>), forma de datos propia (numeroSerie,
 * ubicacion, lote, hu, piezas, etc.), distinta de `p_expPedidoContenedores`. Solo lectura.
 */
export const PROCEDURE_WHITELIST = [
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
