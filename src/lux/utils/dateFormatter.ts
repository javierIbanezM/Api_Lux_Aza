/**
 * Unico punto de conversion Date <-> "dd/MM/yyyy" para hablar con LUX.
 *
 * Regla (docs/lux-api-analysis.md §5.2 / §22): todos los procedimientos de LUX usan el formato
 * dd/MM/yyyy. La capa interna de AZA puede usar objetos Date, pero el adaptador hacia LUX debe
 * pasar siempre por este modulo para evitar conversiones inconsistentes.
 */

const DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Convierte un Date a "dd/MM/yyyy". Lanza si el Date es invalido. */
export function formatDateForLux(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error('formatDateForLux: fecha invalida');
  }
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Parsea una fecha "dd/MM/yyyy" devuelta por LUX a un Date.
 * Devuelve null si la cadena esta vacia (LUX serializa NULL como "").
 * Lanza si la cadena no esta vacia pero no cumple el formato esperado.
 */
export function parseDateFromLux(value: string): Date | null {
  if (value === '') {
    return null;
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`parseDateFromLux: formato de fecha invalido: "${value}"`);
  }
  const [, ddStr, mmStr, yyyyStr] = match as unknown as [string, string, string, string];
  const dd = Number(ddStr);
  const mm = Number(mmStr);
  const yyyy = Number(yyyyStr);
  const date = new Date(yyyy, mm - 1, dd);
  // Verifica que no haya habido "desbordamiento" (p.ej. 31/02/2026 -> 03/03/2026)
  if (date.getFullYear() !== yyyy || date.getMonth() !== mm - 1 || date.getDate() !== dd) {
    throw new Error(`parseDateFromLux: fecha invalida: "${value}"`);
  }
  return date;
}

/** true si la cadena cumple el formato dd/MM/yyyy y es una fecha real. */
export function isValidLuxDateString(value: string): boolean {
  if (value === '') {
    return true; // vacio es valido: significa "sin fecha" / usar valor por defecto del SP
  }
  try {
    parseDateFromLux(value);
    return true;
  } catch {
    return false;
  }
}
