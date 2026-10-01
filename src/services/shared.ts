import { LuxError, LuxValidationError } from '../lux/errors';

/** Linea de un alta (expedicion/recepcion) que no se pudo crear, con el motivo. */
export interface LineaFallida<TInput> {
  input: TInput;
  error: string;
}

/** Valida `input` contra un schema (zod) y lanza `LuxValidationError` si no cumple. */
export function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new LuxValidationError('Datos de entrada invalidos', result.error);
  }
  return result.data as T;
}

/** Mensaje legible de un error cualquiera (para reportar lineas fallidas). */
export function describeError(err: unknown): string {
  if (err instanceof LuxError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
