/**
 * Modelos genericos del endpoint PUT /proc/{procedimiento}.
 *
 * El body de la peticion es siempre un diccionario plano string -> string (nunca incluye
 * usuario ni almacen, ver docs/lux-api-analysis.md §1 y §3). La respuesta es un array de filas
 * heterogeneas (tambien strings), donde la fila relevante para alta/modificacion trae `mensaje`.
 */

/** Body que se envia a PUT /proc/{procedimiento}. Solo strings, nunca usuario/almacen. */
export type ProcRequest = Record<string, string>;

/** Una fila cruda devuelta por LUX. Todos los valores son strings (o "" si eran NULL). */
export type ProcResponseRow = Record<string, string>;

/** Respuesta completa de /proc: array de filas. */
export type ProcResponse = ProcResponseRow[];

/** Fila de resultado de una operacion de escritura (ACTUALIZAR/INSERT/UPDATE). */
export interface ProcWriteResult extends ProcResponseRow {
  mensaje: string;
}

export function isSuccessRow(row: ProcResponseRow | undefined): row is ProcWriteResult {
  return !!row && row.mensaje === 'OK';
}
