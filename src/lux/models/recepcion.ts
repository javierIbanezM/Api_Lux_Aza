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

/**
 * Fila devuelta por p_recAlbaranHUPreinformado (accion=SELECT_INICIO, idParent=idAlbaran).
 * Equivalente de ExpedicionContenedor pero para recepciones (detalle por HU/pallet fisico
 * recepcionado, no por linea de albaran). Procedimiento NO documentado en la guia del proveedor:
 * campos confirmados de forma empirica contra el servidor real de LUX (SAGUNTO) el 2026-09-30,
 * ver docs/lux-api-analysis.md §16. Solo lectura.
 */
export interface RecepcionHU extends Record<string, string> {
  id: string;
  hu: string;
  referencia: string;
  piezas: string;
  lote: string;
  fechaCaducidad: string;
  estado: string;
  ubicacion: string;
  almacenHU: string;
  numeroSerie: string;
  bloqueo: string;
  volumenRecepcion: string;
  pesoRecepcion: string;
  observaciones: string;
}
