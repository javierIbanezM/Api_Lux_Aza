/**
 * Modelos de p_expRutasDeca (DECA de rutas de transporte). Confirmado contra el servidor real de
 * LUX el 2026-10-05; el procedimiento no esta en el PDF del proveedor (dato aportado por el
 * proveedor). Acciones: SELECT (parametro `id` de la ruta o `numeroRuta` EXACTO, sin comodines ni
 * nombre parcial) y SELECT_ENVIOS (todos los eventos/envios de la ruta).
 */

/** Una llamada hecha a la API de LUX (/proc), tal como se envio, mas cuantas filas devolvio. */
export interface LlamadaApi {
  procedimiento: string;
  accion: string;
  /** Parametros enviados (sin usuario ni almacen, que van aparte). */
  parametros: Record<string, string>;
  almacen?: string;
  filas: number;
}

/** Fila de p_expRutasDeca, accion=SELECT: el envio DECA asociado a una ruta (si lo tiene). */
export interface RutaDeca extends Record<string, string> {
  /** Referencia del envio en el transportista: `<numeroRuta>-AZA`. */
  shipmentReference: string;
  /** Estado del envio en LUX (p.ej. ENVIADO). */
  estado: string;
  fechaEnvio: string;
  fechaCreacion: string;
  shipmentId: string;
  documentId: string;
  documentStatus: string;
  shipmentStatus: string;
  usuario: string;
  id: string;
  publicId: string;
  error: string;
}

/** Fila de p_expRutasDeca, accion=SELECT_ENVIOS (eventos del envio). Forma aun no observada con
 *  datos reales (todas las rutas probadas devolvieron cuerpo vacio), por eso es generica. */
export type RutaDecaEnvio = Record<string, string>;
