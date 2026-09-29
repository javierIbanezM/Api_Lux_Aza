/**
 * Ordenacion de columnas para los listados de /almacen (solo presentacion, no es un parametro
 * que soporte LUX: /proc no documenta ningun "orderBy", asi que el orden se aplica aqui, sobre
 * las filas ya devueltas por el SELECT).
 */

export type SortDirection = 'asc' | 'desc';

export function normalizeSortDirection(value: unknown): SortDirection {
  return value === 'desc' ? 'desc' : 'asc';
}

/**
 * LUX devuelve fechas en listados como "dd/MM/yyyy" o "dd/MM/yyyy HH:mm:ss" (visto en datos
 * reales, p.ej. fechaCreacion="25/04/2026 08:13:51"). A diferencia de
 * lux/utils/dateFormatter.ts (que exige el formato exacto dd/MM/yyyy para validar entradas de
 * escritura), esto es un parseo tolerante de solo lectura: si no reconoce el formato, devuelve
 * null y esa fila cae al orden alfabetico normal en vez de romper el listado.
 */
function parseSortableDate(value: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(value);
  if (!match) {
    return null;
  }
  const [, dd, mm, yyyy, hh, min, ss] = match;
  const date = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh ?? '0'),
    Number(min ?? '0'),
    Number(ss ?? '0'),
  );
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function compareValues(a: string, b: string): number {
  if (a === '' && b === '') return 0;
  if (a === '') return -1;
  if (b === '') return 1;
  const da = parseSortableDate(a);
  const db = parseSortableDate(b);
  if (da !== null && db !== null) {
    return da - db;
  }
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

/** Ordena una copia de `rows` por `field` (clave de cada fila). Si `field` no viene, no reordena. */
export function sortRows<T extends Record<string, string>>(
  rows: T[],
  field: string | undefined,
  direction: SortDirection,
): T[] {
  if (!field) {
    return rows;
  }
  const sorted = [...rows].sort((a, b) => compareValues(a[field] ?? '', b[field] ?? ''));
  return direction === 'desc' ? sorted.reverse() : sorted;
}

export interface SortLink {
  href: string;
  indicator: string;
}

/**
 * Construye el href (y el indicador visual ^/v) para el enlace de cabecera de columna `field`,
 * preservando los filtros activos y alternando la direccion si ya se estaba ordenando por esa
 * misma columna.
 */
export function buildSortLinks(
  basePath: string,
  filters: Record<string, string | undefined>,
  fields: string[],
  currentSort: string | undefined,
  currentDir: SortDirection,
): Record<string, SortLink> {
  const links: Record<string, SortLink> = {};
  for (const field of fields) {
    const nextDir: SortDirection = currentSort === field && currentDir === 'asc' ? 'desc' : 'asc';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
    }
    params.set('sort', field);
    params.set('dir', nextDir);
    const indicator = currentSort === field ? (currentDir === 'asc' ? '▲' : '▼') : '';
    links[field] = { href: `${basePath}?${params.toString()}`, indicator };
  }
  return links;
}
