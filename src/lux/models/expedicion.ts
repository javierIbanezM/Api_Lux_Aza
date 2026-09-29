/**
 * Modelos de dominio para expediciones (pedidos de salida).
 * Nombres de campo tal cual docs/lux-api-analysis.md §6. Todo string, sin inventar tipos.
 */

/** Parametros de escritura de cabecera (p_expCabeceraAza, accion=ACTUALIZAR). */
export interface ExpedicionCabeceraInput {
  idPedido: string;
  pedido?: string;
  propietario: string;
  codCliente: string;
  clienteNombre?: string;
  transportista: string;
  serviceLevel?: string;
  tipoPedido?: string;
  fecha?: string;
  prioridad?: string;
  observaciones?: string;
  pedidoCliente?: string;
  bloqueo?: string;
  direccion?: string;
  cp?: string;
  poblacion?: string;
  provincia?: string;
  pais?: string;
  telefono?: string;
  correo?: string;
  contacto?: string;
  razonSocial?: string;
  // Datos extra (semantica null/""/valor, ver lux/utils/procBody.ts)
  facturarTransporte?: string;
  expedicion?: string;
  observacionesAlbaran?: string;
  observacionesAlmacen?: string;
  carga?: string;
  fechaEntrega?: string;
}

/** Fila devuelta por p_expCabeceraAza en SELECT_ONE / tras ACTUALIZAR. */
export interface Expedicion extends Record<string, string> {
  mensaje: string;
  idPedido: string;
  pedido: string;
}

/** Fila del listado p_expedicionesAza (accion=SELECT). Columnas principales, ver §6.3. */
export interface ExpedicionListItem extends Record<string, string> {
  id: string;
  pedido: string;
  propietario: string;
  cliente: string;
  clienteNombre: string;
  estado: string;
  tipo: string;
  fecha: string;
}

/** Filtros admitidos por p_expedicionesAza (accion=SELECT). Todos opcionales, texto usa LIKE. */
export interface ExpedicionListFilters {
  [key: string]: string | undefined;
  pedido?: string;
  propietario?: string;
  cliente?: string;
  clienteNombre?: string;
  estado?: string;
  tipo?: string;
  fecha?: string;
  fecha_fin?: string;
  fechaCreacion?: string;
  fechaCreacion_fin?: string;
  fechaCerrado?: string;
  fechaCerrado_fin?: string;
  expedicion?: string;
  deliveryNumber?: string;
  transportista?: string;
  pedidoCliente?: string;
  observaciones?: string;
  agrupacion?: string;
  prioridad?: string;
  ruta?: string;
  referencia?: string;
  poblacion?: string;
  pais?: string;
  provincia?: string;
}

/** Parametros de p_expPedidoLineas. */
export interface ExpedicionLineaInput {
  pedido?: string;
  idParent?: string;
  id?: string;
  referencia: string;
  cantidadPedida: string;
  linea?: string;
  lote?: string;
  bloqueo?: string;
  observaciones?: string;
  referenciaCliente?: string;
  vidaUtil?: string;
}

export interface ExpedicionLineaUpdateInput {
  id: string;
  pedido?: string;
  idParent?: string;
  referencia?: string;
  cantidadPedida?: string;
  linea?: string;
  lote?: string;
  bloqueo?: string;
  observaciones?: string;
  referenciaCliente?: string;
  vidaUtil?: string;
}

export interface ExpedicionLinea extends Record<string, string> {
  mensaje: string;
  id: string;
}

/**
 * Fila devuelta por p_expPedidoContenedores (accion=SELECT_INICIO, idParent=idPedido).
 * Procedimiento NO documentado en la guia del proveedor (GuiaAPILUX_AZA.pdf): campos confirmados
 * de forma empirica contra el servidor real de LUX (SAGUNTO) el 2026-09-29, ver
 * docs/lux-api-analysis.md §14. Solo lectura; no se ha probado ni se soporta INSERT/UPDATE.
 */
export interface ExpedicionContenedor extends Record<string, string> {
  id: string;
  contenedor: string;
  hu: string;
  referencia: string;
  cantidad: string;
  lote: string;
  fechaCaducidad: string;
  ubicacion: string;
  pallet: string;
  observaciones: string;
  largoContenedor: string;
  anchoContenedor: string;
  altoContenedor: string;
  pesoContenedor: string;
}
