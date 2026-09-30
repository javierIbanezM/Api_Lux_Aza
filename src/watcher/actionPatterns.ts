/**
 * Patrones de lineas de log de LUX que representan una accion de negocio relevante para AZA.
 * Confirmados contra los logs reales (ver docs/lux-api-analysis.md §16). Ninguno de estos
 * procedimientos/acciones de detalle esta documentado en el PDF del proveedor salvo
 * `p_expCabeceraAza`/`p_recCabeceraAza` con `accion=ACTUALIZAR` (esos si vienen del PDF) y
 * `p_expPedidoLineas`/`p_recAlbaranLineas` con `INSERT`/`UPDATE` (tambien del PDF); el resto
 * (cierres, rutas, pasar a almacen) se confirmaron por observacion directa.
 *
 * IMPORTANTE (confirmado por observacion directa, no es un detalle menor): el MISMO procedimiento
 * puede loguearse con el parametro de accion en minusculas (`@accion=`) y justo despues del
 * nombre del procedimiento cuando lo llama nuestra propia API (`usuario='interfaz'`), pero en
 * MAYUSCULAS (`@ACCION=`) y en una posicion distinta de la linea cuando lo llama la interfaz de
 * LUX/la PDA de almacen directamente. Por eso cada regla comprueba el procedimiento y el valor
 * del parametro de accion de forma INDEPENDIENTE (nunca como una unica subcadena contigua), y
 * `extractParam` busca el nombre del parametro sin distinguir mayusculas/minusculas.
 */

export type ActionEventType =
  | 'expedicionCerradaPicking'
  | 'expedicionCerradaOficina'
  | 'expedicionAsignadaARuta'
  | 'expedicionPasadaAlmacen'
  | 'expedicionCabeceraActualizada'
  | 'expedicionLineaModificada'
  | 'recepcionCabeceraActualizada'
  | 'recepcionLineaModificada'
  | 'rutaEnviada';

export interface DetectedEvent {
  type: ActionEventType;
  /** id interno del pedido de expedicion (LUX), si la linea lo lleva. */
  idPedido?: string;
  /** numero de pedido/ASN (texto), si la linea lo lleva. Necesario cuando idPedido es '0' (alta). */
  pedido?: string;
  /** id interno del albaran de recepcion (LUX), si la linea lo lleva. */
  idAlbaran?: string;
  /** numero de albaran (texto), si la linea lo lleva. Necesario cuando idAlbaran es '0' (alta). */
  albaran?: string;
  /** id de la ruta de transporte (solo para 'rutaEnviada'; no es un id de pedido). */
  idRuta?: string;
  rawLine: string;
}

/**
 * Extrae `@nombre='valor'` de una linea. Sin distinguir mayusculas/minusculas en el NOMBRE del
 * parametro (LUX loguea el mismo parametro logico como `@accion=`/`@ACCION=`,
 * `@almacen=`/`@ALMACEN=`, etc. segun quien haga la llamada) y sin asumir ninguna posicion/orden
 * concreto dentro de la linea.
 */
function extractParam(line: string, name: string): string | undefined {
  const match = new RegExp(`@${name}='([^']*)'`, 'i').exec(line);
  return match && match[1] !== '' ? match[1] : undefined;
}

/** true si `exec <procedure>` aparece en la linea, con limite de palabra al final del nombre
 *  (para que `p_expRutas` no coincida dentro de `p_expRutasDetalle`). */
function hasProcedure(line: string, procedure: string): boolean {
  return new RegExp(`exec ${procedure}\\b`).test(line);
}

interface Rule {
  type: ActionEventType;
  procedure: string;
  /** Nombre del parametro que lleva el verbo/estado (comparado sin distinguir mayusculas via
   *  `extractParam`), p.ej. 'accion' o 'estado'. */
  actionParam: string;
  /** Valor(es) exactos que debe tener `actionParam` para que la regla dispare. */
  actionValues: string[];
  build: (line: string) => DetectedEvent | null;
}

const RULES: Rule[] = [
  {
    type: 'expedicionCerradaPicking',
    procedure: 'p_wm_expSinConsolidar',
    actionParam: 'estado',
    actionValues: ['CERRAR'],
    build: (line) => {
      const idPedido = extractParam(line, 'identificador');
      return idPedido ? { type: 'expedicionCerradaPicking', idPedido, rawLine: line } : null;
    },
  },
  {
    type: 'expedicionCerradaOficina',
    procedure: 'p_expediciones',
    actionParam: 'accion',
    actionValues: ['CERRAR_OFICINA_FIN_FORZAR'],
    build: (line) => {
      const idPedido = extractParam(line, 'id');
      return idPedido ? { type: 'expedicionCerradaOficina', idPedido, rawLine: line } : null;
    },
  },
  {
    type: 'expedicionAsignadaARuta',
    // Tercera via de cierre confirmada (distinta de expedicionCerradaPicking/expedicionCerradaOficina):
    // al asignar un pedido a una ruta desde la oficina, LUX inserta una fila en p_expRutasDetalle
    // que ya trae el `estado` resultante (normalmente CERRADO) directamente en la misma linea.
    procedure: 'p_expRutasDetalle',
    actionParam: 'accion',
    actionValues: ['INSERT'],
    build: (line) => {
      const idPedido = extractParam(line, 'id');
      const pedido = extractParam(line, 'pedido');
      return idPedido || pedido ? { type: 'expedicionAsignadaARuta', idPedido, pedido, rawLine: line } : null;
    },
  },
  {
    type: 'rutaEnviada',
    procedure: 'p_expRutas',
    actionParam: 'accion',
    actionValues: ['ENVIAR_FORZAR'],
    build: (line) => {
      const idRuta = extractParam(line, 'id');
      return idRuta ? { type: 'rutaEnviada', idRuta, rawLine: line } : null;
    },
  },
  {
    type: 'expedicionPasadaAlmacen',
    // Exactamente PASAR_ALMACEN_WMS, no la variante de eco PASAR_ALMACEN_WMS_FIN (comparacion de
    // valor exacto via actionValues, no haria falta ademas comprobar la comilla de cierre).
    procedure: 'p_expPasarAlmacenPC',
    actionParam: 'accion',
    actionValues: ['PASAR_ALMACEN_WMS'],
    build: (line) => {
      const idPedido = extractParam(line, 'id');
      return idPedido ? { type: 'expedicionPasadaAlmacen', idPedido, rawLine: line } : null;
    },
  },
  {
    type: 'expedicionCabeceraActualizada',
    procedure: 'p_expCabeceraAza',
    actionParam: 'accion',
    actionValues: ['ACTUALIZAR'],
    build: (line) => {
      const idPedido = extractParam(line, 'idPedido');
      const pedido = extractParam(line, 'pedido');
      return idPedido || pedido ? { type: 'expedicionCabeceraActualizada', idPedido, pedido, rawLine: line } : null;
    },
  },
  {
    type: 'recepcionCabeceraActualizada',
    procedure: 'p_recCabeceraAza',
    actionParam: 'accion',
    actionValues: ['ACTUALIZAR'],
    build: (line) => {
      const idAlbaran = extractParam(line, 'idAlbaran');
      const albaran = extractParam(line, 'albaran');
      return idAlbaran || albaran ? { type: 'recepcionCabeceraActualizada', idAlbaran, albaran, rawLine: line } : null;
    },
  },
  {
    type: 'expedicionLineaModificada',
    procedure: 'p_expPedidoLineas',
    actionParam: 'accion',
    actionValues: ['INSERT', 'UPDATE'],
    build: (line) => {
      const idPedido = extractParam(line, 'idPedido') ?? extractParam(line, 'idParent');
      const pedido = extractParam(line, 'pedido');
      // Se devuelve el evento aunque no se resuelva ninguna referencia (idPedido/pedido ambos
      // ausentes, p.ej. un UPDATE que solo lleva el `id` de la linea): el watcher lo registra
      // como aviso en vez de ignorarlo silenciosamente, para que se note el hueco.
      return { type: 'expedicionLineaModificada', idPedido, pedido, rawLine: line };
    },
  },
  {
    type: 'recepcionLineaModificada',
    procedure: 'p_recAlbaranLineas',
    actionParam: 'accion',
    actionValues: ['INSERT', 'UPDATE'],
    build: (line) => {
      const idAlbaran = extractParam(line, 'idAlbaran') ?? extractParam(line, 'idParent');
      const albaran = extractParam(line, 'albaran');
      return { type: 'recepcionLineaModificada', idAlbaran, albaran, rawLine: line };
    },
  },
];

/** Analiza una linea de log y devuelve el evento detectado, o `null` si no coincide con ninguno. */
export function matchActionLine(line: string): DetectedEvent | null {
  for (const rule of RULES) {
    if (!hasProcedure(line, rule.procedure)) {
      continue;
    }
    const value = extractParam(line, rule.actionParam);
    if (value === undefined || !rule.actionValues.includes(value)) {
      continue;
    }
    return rule.build(line);
  }
  return null;
}
