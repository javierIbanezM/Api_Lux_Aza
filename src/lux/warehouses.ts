/**
 * Almacenes (cabecera "Almacen" de LUX) sobre los que opera AZA con este usuario tecnico.
 *
 * LUX no documenta ningun procedimiento para listar almacenes dinamicamente (no se ha buscado
 * uno inventado); esta lista la aporto el propio equipo de AZA y se mantiene aqui a mano. Si se
 * anade o retira un almacen, actualizar esta lista.
 */
export const WAREHOUSES = ['SAGUNTO', 'CHESTECM', 'ALMUSSAFES', 'MONTAVERNER', 'CHESTE'] as const;

export type Warehouse = (typeof WAREHOUSES)[number];

export function isValidWarehouse(value: string): value is Warehouse {
  return (WAREHOUSES as readonly string[]).includes(value);
}
