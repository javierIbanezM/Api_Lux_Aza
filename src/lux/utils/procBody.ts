/**
 * Construye el body plano string->string que se envia a PUT /proc/{procedimiento}, respetando
 * de forma centralizada la semantica critica de "datos extra" (docs/lux-api-analysis.md §5.3):
 *
 *   - Clave ausente / valor `undefined` / valor `null`  -> NO se incluye la clave  -> "no tocar"
 *   - Clave presente con valor `""`                      -> se incluye como ""     -> "borrar"
 *   - Clave presente con cualquier otro valor            -> se incluye tal cual    -> "fijar"
 *
 * Los valores numericos/booleanos se convierten a string sin redondeos ni formateos adicionales
 * (LUX trata todos los parametros como texto).
 *
 * Este helper es el UNICO lugar donde se debe construir el body de /proc: ningun servicio debe
 * reimplementar esta logica para evitar inconsistencias.
 */

export type ProcBodyInput = Record<string, string | number | boolean | null | undefined>;

export function buildProcBody(input: ProcBodyInput): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      // No tocar: la clave ni siquiera se envia.
      continue;
    }
    body[key] = String(value);
  }
  return body;
}
