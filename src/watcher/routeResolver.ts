import type { LuxClient } from '../lux/client';

/**
 * Resuelve que pedidos de expedicion lleva una ruta de transporte, usando `p_expRutasDetalle`
 * (accion=SELECT, idParent=<idRuta>). Procedimiento NO documentado en el PDF del proveedor;
 * confirmado contra el log real de LUX (`exec p_expRutasDetalle ... @idParent='<idRuta>'`), ver
 * docs/lux-api-analysis.md §16. Devuelve el campo `id` de cada fila (id de pedido de expedicion).
 *
 * Es deliberadamente tolerante: si el procedimiento devuelve un shape inesperado, se ignoran las
 * filas sin `id` valido en vez de lanzar (esto es un watcher de mejor esfuerzo, no la API
 * principal).
 */
export async function resolverPedidosDeRuta(
  luxClient: LuxClient,
  idRuta: string,
  almacen?: string,
): Promise<string[]> {
  const rows = await luxClient.callProc(
    'p_expRutasDetalle',
    'SELECT',
    { idParent: idRuta },
    { operacion: 'watcher.resolverPedidosDeRuta', almacen },
  );

  const idsPedido = new Set<string>();
  for (const row of rows) {
    const id = (row as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim() !== '') {
      idsPedido.add(id.trim());
    }
  }
  return [...idsPedido];
}
