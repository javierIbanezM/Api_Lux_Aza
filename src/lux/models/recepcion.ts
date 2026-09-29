/**
 * Modelos de dominio para recepciones (albaranes de entrada).
 * Nombres de campo tal cual docs/lux-api-analysis.md §7.
 */

/** Parametros de escritura de cabecera (p_recCabeceraAza, accion=ACTUALIZAR). */
export interface RecepcionCabeceraInput {
  idAlbaran: string;
  albaran?: string;
  propietario: string;
  codProveedor?: string;
  fecha?: string;
  tipoAlbaran?: string;
  ue?: string;
  agencia?: string;
  ubicacionRecepcion?: string;
  empresa?: string;
  bloqueo?: string;
  observaciones?: string;
  // Datos extra (semantica null/""/valor)
  matricula?: string;
  matRemolque?: string;
  dni?: string;
  nombre?: string;
  apellidos?: string;
  telefono?: string;
  observacionesPDA?: string;
  descarga?: string;
}

export interface Recepcion extends Record<string, string> {
  mensaje: string;
  idAlbaran: string;
  albaran: string;
}

export interface RecepcionListItem extends Record<string, string> {
  id: string;
  albaran: string;
  propietario: string;
  estado: string;
}

export interface RecepcionListFilters {
  [key: string]: string | undefined;
  albaran?: string;
  matricula?: string;
  proveedor?: string;
  propietario?: string;
  cliente?: string;
  estado?: string;
  tipo?: string;
  observaciones?: string;
  fechaPrevista?: string;
  fechaPrevista_FIN?: string;
  fechaRecepcion?: string;
  fechaRecepcion_FIN?: string;
}

export interface RecepcionLineaInput {
  idParent: string;
  referencia: string;
  piezasAlbaran: string;
  linea?: string;
  lote?: string;
  fechaCaducidad?: string;
  observaciones?: string;
  cliente?: string;
  entrega?: string;
  bloqueo?: string;
}

export interface RecepcionLineaUpdateInput {
  id: string;
  idParent?: string;
  referencia?: string;
  piezasAlbaran?: string;
  linea?: string;
  lote?: string;
  fechaCaducidad?: string;
  observaciones?: string;
  cliente?: string;
  entrega?: string;
  bloqueo?: string;
}

export interface RecepcionLinea extends Record<string, string> {
  mensaje: string;
  id: string;
}
