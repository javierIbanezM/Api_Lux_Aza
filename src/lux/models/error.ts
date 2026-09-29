/** Fila de error funcional tal como la devuelve LUX (ver docs/lux-api-analysis.md §5.4). */
export interface LuxErrorRow {
  mensaje: string;
  campo?: string;
  tab?: string;
  [key: string]: string | undefined;
}
