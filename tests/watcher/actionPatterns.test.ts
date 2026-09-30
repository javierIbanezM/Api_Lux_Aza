import { describe, expect, it } from 'vitest';
import { matchActionLine } from '../../src/watcher/actionPatterns';

describe('watcher/actionPatterns', () => {
  it('detecta el cierre de picking con discrepancias (LUX_mobile)', () => {
    const line =
      "30-sep-2026 12:46:39 INFO:   [] exec p_wm_expSinConsolidar @estado='CERRAR',@valor='',@almacen='SAGUNTO',@usuario='JIbanezM',@valor2='326857',@terminal='900b9768d4eb624f',@identificador='11115'";
    const event = matchActionLine(line);
    expect(event).toEqual({ type: 'expedicionCerradaPicking', idPedido: '11115', rawLine: line });
  });

  it('detecta el cierre de oficina forzado (LUX)', () => {
    const line =
      "30-sep-2026 12:46:48 INFO:   [] exec p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'";
    const event = matchActionLine(line);
    expect(event).toEqual({ type: 'expedicionCerradaOficina', idPedido: '11115', rawLine: line });
  });

  it('detecta el envio forzado de una ruta (LUX)', () => {
    const line =
      "30-sep-2026 12:57:22 INFO:   [] exec p_expRutas @accion='ENVIAR_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='4487'";
    const event = matchActionLine(line);
    expect(event).toEqual({ type: 'rutaEnviada', idRuta: '4487', rawLine: line });
  });

  it('ignora lineas de solo lectura (SELECT) sobre los mismos procedimientos', () => {
    const line =
      "30-sep-2026 11:30:40 INFO:   [] exec p_expedicionesAza @accion='SELECT',@propietario='CAMELIA',@almacen='SAGUNTO',@usuario='interfaz'";
    expect(matchActionLine(line)).toBeNull();
  });

  it('ignora otras acciones/estados del mismo procedimiento que no son las vigiladas', () => {
    expect(
      matchActionLine("... exec p_wm_expSinConsolidar @estado='PEDIR_CERRAR',@identificador='11115' ..."),
    ).toBeNull();
    expect(matchActionLine("... exec p_expediciones @accion='CERRAR_OFICINA_INICIO',@id='11115' ...")).toBeNull();
    expect(matchActionLine("... exec p_expRutas @accion='ENVIAR',@id='4487' ...")).toBeNull();
  });

  it('ignora lineas que no son de exec en absoluto', () => {
    expect(matchActionLine('30-sep-2026 12:50:12 INFO:   Static request apps: GET: /dataprovider/expRutas.json')).toBeNull();
  });

  it('detecta "pasar a almacen" y no confunde con la variante _FIN', () => {
    const pasar = matchActionLine(
      "30-sep-2026 12:46:15 INFO:   [] exec p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'",
    );
    expect(pasar).toMatchObject({ type: 'expedicionPasadaAlmacen', idPedido: '11115' });

    const fin = matchActionLine(
      "30-sep-2026 12:46:15 INFO:   [] exec p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS_FIN',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'",
    );
    expect(fin).toBeNull();
  });

  it('detecta alta/edicion de cabecera de expedicion (p_expCabeceraAza ACTUALIZAR), con idPedido y pedido', () => {
    const line =
      "28-sep-2026 14:30:55 INFO:   [] exec p_expCabeceraAza @accion='ACTUALIZAR',@idPedido='11115',@pedido='EXP0000074',@propietario='AZA LOGISTICS SLU',@usuario='RCaroH'";
    expect(matchActionLine(line)).toMatchObject({
      type: 'expedicionCabeceraActualizada',
      idPedido: '11115',
      pedido: 'EXP0000074',
    });
  });

  it('detecta alta de cabecera de expedicion con idPedido="0" (solo texto de pedido)', () => {
    const line =
      "28-sep-2026 09:42:17 INFO:   [] exec p_expCabeceraAza @accion='ACTUALIZAR',@idPedido='0',@pedido='EXP0000099',@usuario='ARodriguezSP'";
    expect(matchActionLine(line)).toMatchObject({ type: 'expedicionCabeceraActualizada', idPedido: '0', pedido: 'EXP0000099' });
  });

  it('detecta alta/edicion de cabecera de recepcion (p_recCabeceraAza ACTUALIZAR)', () => {
    const line =
      "28-sep-2026 15:37:03 INFO:   [] exec p_recCabeceraAza @accion='ACTUALIZAR',@idAlbaran='0',@codProveedor='ROC',@albaran='ALB-99',@usuario='ARodriguezSP'";
    expect(matchActionLine(line)).toMatchObject({ type: 'recepcionCabeceraActualizada', idAlbaran: '0', albaran: 'ALB-99' });
  });

  it('detecta alta/edicion de linea de expedicion (INSERT/UPDATE), usando idParent si no hay idPedido', () => {
    const insert =
      "16-sep-2026 08:10:04 INFO:   [] exec p_expPedidoLineas @accion='INSERT',@referencia='3760297544959',@idParent='11115'";
    expect(matchActionLine(insert)).toMatchObject({ type: 'expedicionLineaModificada', idPedido: '11115' });
  });

  it('detecta linea de expedicion modificada aunque no traiga ninguna referencia resoluble (se resuelve en el watcher, no aqui)', () => {
    const update = "30-sep-2026 10:00:00 INFO:   [] exec p_expPedidoLineas @accion='UPDATE',@id='55010',@cantidadPedida='30'";
    expect(matchActionLine(update)).toMatchObject({ type: 'expedicionLineaModificada', idPedido: undefined, pedido: undefined });
  });

  it('detecta alta/edicion de linea de recepcion (p_recAlbaranLineas)', () => {
    const insert = "27-ago-2026 10:00:00 INFO:   [] exec p_recAlbaranLineas @accion='INSERT',@referencia='REF-1',@idParent='3012'";
    expect(matchActionLine(insert)).toMatchObject({ type: 'recepcionLineaModificada', idAlbaran: '3012' });
  });

  it('detecta la asignacion de un pedido a una ruta (p_expRutasDetalle ACCION=INSERT), con @ACCION en mayusculas y al final de la linea', () => {
    // Linea real confirmada (pedido EXP0000076, propietario DIPISTOL, cierre via ruta en vez de
    // via p_expediciones/CERRAR_OFICINA_FIN_FORZAR o p_wm_expSinConsolidar/CERRAR).
    const line =
      "28-sep-2026 15:44:09 INFO:   [] exec p_expRutasDetalle @estado='CERRADO',@propietario='DIPISTOL',@provincia='',@ALMACEN='SAGUNTO',@USUARIO='ARodriguezSP',@fechaCierre='28/09/2026 15:43:22',@cliente='GENERICO',@expedicion='1000402946',@poblacionEnvio='Valencia',@pedido='EXP0000076',@id='11120',@ACCION='INSERT',@idParent='4476'";
    expect(matchActionLine(line)).toMatchObject({ type: 'expedicionAsignadaARuta', idPedido: '11120', pedido: 'EXP0000076' });
  });

  it('no confunde p_expRutasDetalle (SELECT de solo lectura) con la insercion que asigna el pedido a la ruta', () => {
    const select =
      "30-sep-2026 12:53:06 INFO:   [] exec p_expRutasDetalle @estado='',@propietario='',@provincia='',@ALMACEN='SAGUNTO',@USUARIO='JIbanezM',@fechaCierre='',@cliente='',@expedicion='',@poblacionEnvio='',@pedido='',@id='',@ACCION='SELECT',@idParent='4487'";
    expect(matchActionLine(select)).toBeNull();
  });

  it('REGRESION: detecta alta de linea de expedicion cuando la llama la UI de LUX directamente (@ACCION en mayusculas, no adyacente al nombre del procedimiento, orden de parametros distinto)', () => {
    // Linea real confirmada: a diferencia de las llamadas de nuestra propia API (que mandan
    // @accion en minusculas justo despues del nombre del procedimiento), la UI de LUX registra
    // esta misma llamada con @ACCION en mayusculas y en una posicion tardia de la linea.
    const line =
      "30-sep-2026 12:46:07 INFO:   [] exec p_expPedidoLineas @pedidoOriginal='',@lote='',@restriccionZona='',@cantidadPedida='10',@tipoOleada='',@bloqueo='',@ALMACEN='SAGUNTO',@linea='',@vidaUtil='',@USUARIO='JIbanezM',@observaciones='',@almacenVirtual='',@id='',@ACCION='INSERT',@referencia='180950',@idParent='11115'";
    expect(matchActionLine(line)).toMatchObject({ type: 'expedicionLineaModificada', idPedido: '11115' });
  });
});
