import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthManager } from '../../src/auth';
import { LuxClient } from '../../src/lux/client';
import { ExpedicionesService } from '../../src/services/expediciones';
import { RecepcionesService } from '../../src/services/recepciones';
import { RutasService } from '../../src/services/rutas';
import { createLogger } from '../../src/logging';
import { LuxActionWatcher } from '../../src/watcher/luxActionWatcher';
import type { WatcherConfig } from '../../src/watcher/watcherConfig';
import type { WatcherSink } from '../../src/watcher/watcherSink';
import { LuxMockServer } from '../mocks/luxMockServer';
import { buildTestConfig } from '../mocks/testConfig';

/** Espera hasta que `predicate()` sea true o se agote el tiempo (sondeo simple, sin fake timers:
 *  el watcher usa setInterval/setTimeout reales con intervalos muy cortos en estos tests). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: tiempo agotado esperando la condicion');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe('watcher/LuxActionWatcher', () => {
  let dir: string;
  let luxLogPath: string;
  let mobileLogPath: string;
  let mock: LuxMockServer;
  let baseUrl: string;
  let watcher: LuxActionWatcher;
  let logLines: Record<string, unknown>[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  const config: WatcherConfig = {
    luxUsername: 'apiUser',
    luxLogPath: '',
    luxMobileLogPath: '',
    pollIntervalMs: 20,
    debounceMs: 30,
    maxWaitMs: 500,
    retryDelayMs: 60_000,
    stateDir: '',
    rutasDecaDir: '',
    revisarFicherosDeca: 3,
    borrarJsonFinales: false,
    docutenApiKey: undefined,
    docutenBaseUrl: 'http://docuten.invalid/api/v1',
    jsonEventsDir: '', // no usado en estos tests: LuxActionWatcher no conoce jsonFileSink, solo WatcherSink
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lux-watcher-'));
    luxLogPath = join(dir, 'lux.log.0');
    config.stateDir = join(dir, 'state');
    mobileLogPath = join(dir, 'lux_mobile.log.0');
    writeFileSync(luxLogPath, '');
    writeFileSync(mobileLogPath, '');
    config.luxLogPath = luxLogPath;
    config.luxMobileLogPath = mobileLogPath;

    mock = new LuxMockServer();
    baseUrl = await mock.listen();

    logLines = [];
    const capture = (line: string) => {
      try {
        logLines.push(JSON.parse(line));
      } catch {
        // ignora lineas no-JSON
      }
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(async () => {
    watcher.stop();
    logSpy.mockRestore();
    await mock.close();
    await new Promise((resolve) => setTimeout(resolve, 50)); // deja terminar un sondeo en vuelo (guarda estado en `dir`)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function buildWatcher(sink?: WatcherSink): LuxActionWatcher {
    const appConfig = buildTestConfig({ luxBaseUrl: baseUrl });
    const auth = new AuthManager(appConfig, createLogger('error'));
    const luxClient = new LuxClient(appConfig, auth, createLogger('error'));
    const expedicionesService = new ExpedicionesService(luxClient);
    const recepcionesService = new RecepcionesService(luxClient);
    const rutasService = new RutasService(luxClient, expedicionesService);
    return new LuxActionWatcher(config, luxClient, expedicionesService, recepcionesService, createLogger('debug'), sink, rutasService);
  }

  /** Arranca el watcher y espera a que el primer sondeo (que fija la linea base, ver LogTailer)
   *  ya haya ocurrido, para evitar que la primera linea anadida en el test se trate como
   *  historico y se ignore. */
  async function startAndWaitBaseline(sink?: WatcherSink): Promise<void> {
    watcher = buildWatcher(sink);
    watcher.start();
    // La linea base queda fijada cuando el tailer guarda su estado inicial en disco.
    await waitUntil(
      () => existsSync(join(config.stateDir, 'lux.state.json')) && existsSync(join(config.stateDir, 'lux-mobile.state.json')),
    );
  }

  it('detecta el cierre de picking (LUX_mobile) y re-consulta el pedido, agrupando lineas repetidas en una sola llamada', async () => {
    let llamadasCabecera = 0;
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          llamadasCabecera += 1;
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'DISCREPANCIAS' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    // Dos lineas seguidas del mismo pedido, dentro de la ventana de debounce: deben agruparse.
    appendFileSync(
      mobileLogPath,
      "30-sep-2026 12:46:33 INFO:   [] exec p_wm_expSinConsolidar @estado='SELECT_DATOS',@identificador='11115'\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    appendFileSync(
      mobileLogPath,
      "30-sep-2026 12:46:39 INFO:   [] exec p_wm_expSinConsolidar @estado='CERRAR',@identificador='11115'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));

    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({
      idPedido: '11115',
      pedido: 'EXP0000074',
      propietario: 'AZA LOGISTICS SLU',
      estado: 'DISCREPANCIAS',
      motivos: 'expedicionCerradaPicking',
    });
    expect(llamadasCabecera).toBe(1); // una sola llamada pese a dos lineas de log
  });

  it('detecta el envio de una ruta (LUX), la resuelve a sus pedidos y re-consulta cada uno', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expRutasDetalle' && body.idParent === '4487') {
          return { status: 200, body: [{ id: '11115' }, { id: '11200' }] };
        }
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          const pedido = body.idPedido === '11115' ? 'EXP0000074' : 'EXP0000080';
          return { status: 200, body: [{ mensaje: 'OK', idPedido: body.idPedido, pedido }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '1', pedido: body.pedido, propietario: 'AZA LOGISTICS SLU', estado: 'ENVIADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 12:57:22 INFO:   [] exec p_expRutas @accion='ENVIAR_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='4487'\n",
    );

    await waitUntil(() => logLines.filter((l) => l.operacion === 'watcher.pedidoActualizado').length >= 2);

    const idsPedido = logLines
      .filter((l) => l.operacion === 'watcher.pedidoActualizado')
      .map((l) => l.idPedido)
      .sort();
    expect(idsPedido).toEqual(['11115', '11200']);
  });

  it('detecta el cierre de oficina forzado (LUX)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CERRADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 12:46:48 INFO:   [] exec p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11115', estado: 'CERRADO', motivos: 'expedicionCerradaOficina' });
  });

  it('re-consulta usando el almacen REAL de la linea de log, no el almacen por defecto de la configuracion (bug multi-almacen)', async () => {
    // El almacen por defecto de este test es 'ALM01' (ver tests/mocks/testConfig.ts), distinto de
    // 'MONTAVERNER': si el watcher usara el almacen por defecto en vez del real de la linea (como
    // hacia antes de este fix), LUX devolveria datos vacios/incorrectos para cualquier pedido que
    // no fuera del almacen por defecto (confirmado contra el servidor real).
    mock.updateOptions({
      onProc: (proc, body, headers) => {
        expect(headers.almacen).toBe('MONTAVERNER');
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11060', pedido: 'PRUEBA KITS21' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11060', pedido: 'PRUEBA KITS21', propietario: 'PANCRACIO', estado: 'EXPEDICION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 12:46:48 INFO:   [] exec p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR',@almacen='MONTAVERNER',@usuario='JIbanezM',@id='11060'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11060', almacen: 'MONTAVERNER', propietario: 'PANCRACIO', estado: 'EXPEDICION' });
  });

  it('detecta "pasar a almacen" (LUX)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'ASIGNADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 12:46:15 INFO:   [] exec p_expPasarAlmacenPC @accion='PASAR_ALMACEN_WMS',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11115', estado: 'ASIGNADO', motivos: 'expedicionPasadaAlmacen' });
  });

  it('detecta la reapertura forzada de una expedicion (caso real EXP0000076/DIPISTOL)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11120', pedido: 'EXP0000076' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11120', pedido: 'EXP0000076', propietario: 'DIPISTOL', estado: 'PENDIENTE' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 15:26:47 INFO:   [] exec p_expediciones @accion='REABRIR_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11120'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11120', pedido: 'EXP0000076', estado: 'PENDIENTE', motivos: 'expedicionReabierta' });
  });

  it('detecta la asignacion de un pedido a una ruta (p_expRutasDetalle ACCION=INSERT, caso real EXP0000076)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11120', pedido: 'EXP0000076' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11120', pedido: 'EXP0000076', propietario: 'DIPISTOL', estado: 'CERRADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "28-sep-2026 15:44:09 INFO:   [] exec p_expRutasDetalle @estado='CERRADO',@propietario='DIPISTOL',@fechaCierre='28/09/2026 15:43:22',@pedido='EXP0000076',@id='11120',@ACCION='INSERT',@idParent='4476'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11120', pedido: 'EXP0000076', estado: 'CERRADO', motivos: 'expedicionAsignadaARuta' });
  });

  it('detecta el alta de una expedicion nueva (idPedido="0", solo se conoce el texto de pedido)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          // No deberia llamar a SELECT_ONE con idPedido='0' (no hay cabecera real que consultar
          // todavia), pero si con el id ya resuelto via el resumen del listado (mas abajo).
          if (body.idPedido === '0') {
            throw new Error('No deberia consultar SELECT_ONE con idPedido 0');
          }
          return { status: 200, body: [{ mensaje: 'OK', idPedido: body.idPedido, pedido: 'EXP0000099' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT' && body.pedido === 'EXP0000099') {
          return { status: 200, body: [{ id: '99999', pedido: 'EXP0000099', propietario: 'AZA LOGISTICS SLU', estado: 'CREACION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 09:42:17 INFO:   [] exec p_expCabeceraAza @accion='ACTUALIZAR',@idPedido='0',@propietario='AZA LOGISTICS SLU',@pedido='EXP0000099',@usuario='ARodriguezSP'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '99999', pedido: 'EXP0000099', estado: 'CREACION', motivos: 'expedicionCabeceraActualizada' });
  });

  it('detecta la edicion de cabecera de una expedicion existente (direccion, service level...)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CREACION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 14:30:55 INFO:   [] exec p_expCabeceraAza @accion='ACTUALIZAR',@idPedido='11115',@pedido='EXP0000074',@transportista='SUSMEDIOS',@usuario='RCaroH'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11115', pedido: 'EXP0000074', motivos: 'expedicionCabeceraActualizada' });
  });

  it('detecta el alta de una linea de expedicion (idParent)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CREACION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "16-sep-2026 08:10:04 INFO:   [] exec p_expPedidoLineas @accion='INSERT',@lote='L2026',@cantidadPedida='24',@usuario='interfaz',@linea='2',@referencia='3760297544959',@idParent='11115'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.pedidoActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.pedidoActualizado');
    expect(evento).toMatchObject({ idPedido: '11115', motivos: 'expedicionLineaModificada' });
  });

  it('registra un aviso (sin llamar a la API) si una linea modificada no trae ninguna referencia resoluble', async () => {
    mock.updateOptions({ onProc: () => ({ status: 200, body: [{ mensaje: 'OK' }] }) });

    await startAndWaitBaseline();

    // UPDATE que solo trae el id de la propia linea, sin idPedido/idParent/pedido -- no se puede
    // resolver a que pedido pertenece con la informacion de esta unica linea de log.
    appendFileSync(luxLogPath, "30-sep-2026 10:00:00 INFO:   [] exec p_expPedidoLineas @accion='UPDATE',@id='55010',@cantidadPedida='30'\n");

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.sinReferencia'));
    const aviso = logLines.find((l) => l.operacion === 'watcher.sinReferencia');
    expect(aviso).toMatchObject({ tipo: 'expedicionLineaModificada', resultado: 'ERROR' });
    expect(logLines.some((l) => l.operacion === 'watcher.pedidoActualizado')).toBe(false);
  });

  it('detecta el alta de una recepcion nueva (idAlbaran="0", solo se conoce el texto de albaran)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          if (body.idAlbaran === '0') {
            throw new Error('No deberia consultar SELECT_ONE con idAlbaran 0');
          }
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: body.idAlbaran, albaran: 'ALB-99' }] };
        }
        if (proc === 'p_recepcionesAza' && body.accion === 'SELECT' && body.albaran === 'ALB-99') {
          return { status: 200, body: [{ id: '8000', albaran: 'ALB-99', propietario: 'ROC', estado: 'CREACION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "28-sep-2026 15:37:03 INFO:   [] exec p_recCabeceraAza @accion='ACTUALIZAR',@idAlbaran='0',@codProveedor='ROC',@propietario='ROC',@albaran='ALB-99',@usuario='ARodriguezSP'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.albaranActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.albaranActualizado');
    expect(evento).toMatchObject({ idAlbaran: '8000', albaran: 'ALB-99', estado: 'CREACION', motivos: 'recepcionCabeceraActualizada' });
  });

  it('detecta la confirmacion de una linea de recepcion contra su HU, y no con el menu intermedio de valor vacio (caso real REC0000068)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '7838', albaran: 'REC0000068' }] };
        }
        if (proc === 'p_recepcionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '7838', albaran: 'REC0000068', propietario: 'FARMALIDER', estado: 'PTE. RECEPCION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    // Menu intermedio (valor vacio): no debe disparar nada.
    appendFileSync(
      mobileLogPath,
      "30-sep-2026 15:36:08 INFO:   [] exec p_wm_recepcion @estado='SELECT_MOVIMIENTO',@valor='',@almacen='SAGUNTO',@usuario='ARodriguezSP',@valor2='326858',@terminal='94fdca19a3326f42',@identificador='7838'\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(logLines.some((l) => l.operacion === 'watcher.albaranActualizado' || l.operacion === 'watcher.sinReferencia')).toBe(false);

    // Confirmacion real (valor = HU escaneada): si debe disparar.
    appendFileSync(
      mobileLogPath,
      "30-sep-2026 15:36:53 INFO:   [] exec p_wm_recepcion @estado='SELECT_MOVIMIENTO',@valor='TAS3009261536',@almacen='SAGUNTO',@usuario='ARodriguezSP',@valor2='326858',@terminal='94fdca19a3326f42',@identificador='7838'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.albaranActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.albaranActualizado');
    expect(evento).toMatchObject({
      idAlbaran: '7838',
      albaran: 'REC0000068',
      estado: 'PTE. RECEPCION',
      motivos: 'recepcionLineaConfirmada',
    });
  });

  it('incluye las HUs fisicas (p_recAlbaranHUPreinformado) en el resultado, caso real REC0000068', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '7838', albaran: 'REC0000068' }] };
        }
        if (proc === 'p_recepcionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '7838', albaran: 'REC0000068', propietario: 'FARMALIDER', estado: 'RECIBIDO' }] };
        }
        if (proc === 'p_recAlbaranHUPreinformado' && body.accion === 'SELECT_INICIO' && body.idParent === '7838') {
          return {
            status: 200,
            body: [{ id: '377114', hu: '000008901 [TAS3009261536]', referencia: '0260200002', piezas: '40.0000', lote: 'SL', estado: 'RECEPCIONADO' }],
          };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const onAlbaranActualizado = vi.fn();
    await startAndWaitBaseline({ onAlbaranActualizado });

    appendFileSync(
      mobileLogPath,
      "30-sep-2026 15:36:59 INFO:   [] exec p_wm_recepcionCerrar @estado='CONFIRMAR_CERRAR',@valor='',@almacen='SAGUNTO',@usuario='ARodriguezSP',@valor2='326859',@terminal='94fdca19a3326f42',@identificador='7838'\n",
    );

    await waitUntil(() => onAlbaranActualizado.mock.calls.length > 0);
    expect(onAlbaranActualizado.mock.calls[0]?.[0]).toMatchObject({
      idAlbaran: '7838',
      hus: [{ id: '377114', hu: '000008901 [TAS3009261536]', referencia: '0260200002', piezas: '40.0000' }],
    });
  });

  it('detecta el cierre fisico de una recepcion desde la PDA (caso real REC0000068/FARMALIDER)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '7838', albaran: 'REC0000068' }] };
        }
        if (proc === 'p_recepcionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '7838', albaran: 'REC0000068', propietario: 'FARMALIDER', estado: 'RECIBIDO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      mobileLogPath,
      "30-sep-2026 15:36:59 INFO:   [] exec p_wm_recepcionCerrar @estado='CONFIRMAR_CERRAR',@valor='',@almacen='SAGUNTO',@usuario='ARodriguezSP',@valor2='326859',@terminal='94fdca19a3326f42',@identificador='7838'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.albaranActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.albaranActualizado');
    expect(evento).toMatchObject({
      idAlbaran: '7838',
      albaran: 'REC0000068',
      estado: 'RECIBIDO',
      motivos: 'recepcionCerradaPicking',
    });
  });

  it('detecta "pasar a almacen" de una recepcion (caso real REC0000068/FARMALIDER)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_recCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idAlbaran: '7838', albaran: 'REC0000068' }] };
        }
        if (proc === 'p_recepcionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '7838', albaran: 'REC0000068', propietario: 'FARMALIDER', estado: 'PTE. RECEPCION' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    await startAndWaitBaseline();

    appendFileSync(
      luxLogPath,
      "30-sep-2026 14:29:19 INFO:   [] exec p_recepciones @accion='PASAR_ALMACEN',@almacen='SAGUNTO',@usuario='ARodriguezSP',@id='7838'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.albaranActualizado'));
    const evento = logLines.find((l) => l.operacion === 'watcher.albaranActualizado');
    expect(evento).toMatchObject({
      idAlbaran: '7838',
      albaran: 'REC0000068',
      estado: 'PTE. RECEPCION',
      motivos: 'recepcionPasadaAlmacen',
    });
  });

  it('llama al sink (paso 3, futura persistencia) con el resultado tras un refresco correcto de expedicion', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CERRADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const onExpedicionActualizada = vi.fn();
    await startAndWaitBaseline({ onExpedicionActualizada });

    appendFileSync(
      luxLogPath,
      "30-sep-2026 12:46:48 INFO:   [] exec p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'\n",
    );

    await waitUntil(() => onExpedicionActualizada.mock.calls.length > 0);
    expect(onExpedicionActualizada).toHaveBeenCalledWith({
      idPedido: '11115',
      pedido: 'EXP0000074',
      almacen: 'SAGUNTO',
      propietario: 'AZA LOGISTICS SLU',
      estado: 'CERRADO',
      motivos: ['expedicionCerradaOficina'],
      cabecera: { mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' },
      listado: { id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CERRADO' },
      lineas: [],
      contenedores: [],
    });
  });

  it('pasa al sink el terminal (PDA) de la linea de log que disparo el evento', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CERRADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const onExpedicionActualizada = vi.fn();
    await startAndWaitBaseline({ onExpedicionActualizada });

    appendFileSync(
      mobileLogPath,
      "30-sep-2026 12:46:39 INFO:   [] exec p_wm_expSinConsolidar @estado='CERRAR',@valor='',@almacen='SAGUNTO',@usuario='JIbanezM',@valor2='326857',@terminal='0a3287f025a30edd',@identificador='11115'\n",
    );

    await waitUntil(() => onExpedicionActualizada.mock.calls.length > 0);
    expect(onExpedicionActualizada.mock.calls[0]?.[0]).toMatchObject({ idPedido: '11115', terminal: '0a3287f025a30edd' });
  });

  it('registra en el sink una ruta enviada que en LUX no tiene ningun pedido (ruta vacia)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expRutasDetalle' && body.idParent === '14586') {
          return { status: 200, body: [] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const onRutaEnviadaSinPedidos = vi.fn();
    await startAndWaitBaseline({ onRutaEnviadaSinPedidos });

    appendFileSync(
      luxLogPath,
      "01-oct-2026 18:56:35 INFO:   [] exec p_expRutas @accion='ENVIAR_FORZAR',@almacen='SAGUNTO',@usuario='JCRedolarS',@id='14586'\n",
    );

    await waitUntil(() => onRutaEnviadaSinPedidos.mock.calls.length > 0);
    expect(onRutaEnviadaSinPedidos.mock.calls[0]?.[0]).toMatchObject({
      idRuta: '14586',
      almacen: 'SAGUNTO',
      pedidos: [],
    });
    expect(logLines.some((l) => l.operacion === 'watcher.rutaSinPedidos')).toBe(true);
  });

  const respuestaPedido = (estado = 'CERRADO') => (proc: string, body: Record<string, string>) => {
    if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
      return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
    }
    if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
      return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado }] };
    }
    return { status: 404, body: { mensaje: 'no mockeado' } };
  };
  const lineaCierre = (n: number): string =>
    `30-sep-2026 12:46:${String(n % 60).padStart(2, '0')} INFO:   [] exec p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'\n`;

  it('con actividad continua refresca igualmente al llegar al tope maximo de espera (maxWaitMs)', async () => {
    mock.updateOptions({ onProc: respuestaPedido() });
    const originalDebounce = config.debounceMs;
    const originalMaxWait = config.maxWaitMs;
    config.debounceMs = 150; // cada linea (cada 40 ms) reinicia el debounce: sin tope nunca dispararia
    config.maxWaitMs = 400;
    try {
      const onExpedicionActualizada = vi.fn();
      await startAndWaitBaseline({ onExpedicionActualizada });

      const inicio = Date.now();
      let primerRefrescoMs = -1;
      for (let i = 0; i < 40; i += 1) {
        appendFileSync(luxLogPath, lineaCierre(i));
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (primerRefrescoMs < 0 && onExpedicionActualizada.mock.calls.length > 0) {
          primerRefrescoMs = Date.now() - inicio;
        }
      }
      await waitUntil(() => onExpedicionActualizada.mock.calls.length > 0);
      const duracionActividad = 40 * 40;
      // Refresco antes de que terminara la actividad continua (~1600 ms), y no antes del tope.
      expect(primerRefrescoMs).toBeGreaterThan(0);
      expect(primerRefrescoMs).toBeLessThan(duracionActividad - 200);
    } finally {
      config.debounceMs = originalDebounce;
      config.maxWaitMs = originalMaxWait;
    }
  });

  it('reintenta un refresco fallido por LUX caido (error transitorio) hasta que sale bien, sin perder el evento', async () => {
    const originalRetry = config.retryDelayMs;
    config.retryDelayMs = 40;
    let luxCaido = true;
    const ok = respuestaPedido();
    mock.updateOptions({
      onProc: (proc, body) => (luxCaido ? { status: 503, body: { mensaje: 'caido' } } : ok(proc, body)),
    });
    try {
      const onExpedicionActualizada = vi.fn();
      await startAndWaitBaseline({ onExpedicionActualizada });
      appendFileSync(luxLogPath, lineaCierre(1));

      await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.refreshError' && l.reintentara === true), 8000);
      expect(onExpedicionActualizada).not.toHaveBeenCalled();

      luxCaido = false; // LUX vuelve
      await waitUntil(() => onExpedicionActualizada.mock.calls.length > 0, 8000);
      expect(onExpedicionActualizada.mock.calls[0]?.[0]).toMatchObject({ idPedido: '11115', estado: 'CERRADO' });
    } finally {
      config.retryDelayMs = originalRetry;
    }
  });

  it('no pierde un evento si el watcher se para antes de procesarlo: el siguiente arranque lo recupera', async () => {
    mock.updateOptions({ onProc: respuestaPedido() });
    const originalDebounce = config.debounceMs;
    const originalMaxWait = config.maxWaitMs;
    config.debounceMs = 600; // da tiempo a parar el primer watcher con el evento aun pendiente
    config.maxWaitMs = 1500;
    try {
      const sinkA = vi.fn();
      await startAndWaitBaseline({ onExpedicionActualizada: sinkA });
      appendFileSync(luxLogPath, lineaCierre(1));
      await new Promise((resolve) => setTimeout(resolve, 150)); // leida (sondeo 20 ms), pero en debounce
      await watcher.stop(); // se para con el evento pendiente: NO debe confirmarse la posicion
      expect(sinkA).not.toHaveBeenCalled();

      const sinkB = vi.fn();
      watcher = buildWatcher({ onExpedicionActualizada: sinkB });
      watcher.start(); // reinicio: relee desde la ultima posicion confirmada
      await waitUntil(() => sinkB.mock.calls.length > 0, 8000);
      expect(sinkB.mock.calls[0]?.[0]).toMatchObject({ idPedido: '11115' });
    } finally {
      config.debounceMs = originalDebounce;
      config.maxWaitMs = originalMaxWait;
    }
  });

  const RUTA_EXACTA = 'RT00013615_2026_COMP MAMENTRANS007 S.L.';
  const lineaRuta = (usuario: string): string =>
    `05-oct-2026 10:22:35 INFO:   [] exec p_expedicionesAza @extraMostrar='',@estado='',@tipo='',@generarDeca='',@fechaCerrado_FIN='',@ruta='%RT00013615_2026_COMP %',@ALMACEN='SAGUNTO',@ACCION='SELECT',@USUARIO='${usuario}'\n`;
  const mockDeca = () => {
    const llamadas: string[] = [];
    mock.updateOptions({
      onProc: (proc, body) => {
        llamadas.push(`${proc}:${body.accion}:${body.numeroRuta ?? body.ruta ?? ''}`);
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT' && body.ruta) {
          return { status: 200, body: [{ id: '42', pedido: 'P1', estado: 'ASIGNADO', ruta: RUTA_EXACTA }] };
        }
        if (proc === 'p_expRutasDeca' && body.accion === 'SELECT' && body.numeroRuta === RUTA_EXACTA) {
          return { status: 200, body: [{ shipmentReference: `${RUTA_EXACTA}-AZA`, estado: 'ENVIADO', shipmentStatus: 'created' }] };
        }
        if (proc === 'p_expRutasDeca' && body.accion === 'SELECT_ENVIOS') {
          return { status: 200, body: [] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });
    return llamadas;
  };

  it('consultar una ruta en la pantalla de expediciones: resuelve el nombre exacto y guarda su DECA (p_expRutasDeca)', async () => {
    const llamadas = mockDeca();
    const onRutaDecaActualizada = vi.fn();
    await startAndWaitBaseline({ onRutaDecaActualizada });

    appendFileSync(luxLogPath, lineaRuta('MMartosL'));

    await waitUntil(() => onRutaDecaActualizada.mock.calls.length > 0, 5000);
    expect(onRutaDecaActualizada.mock.calls[0]?.[0]).toMatchObject({
      numeroRuta: RUTA_EXACTA,
      consultaOriginal: '%RT00013615_2026_COMP %',
      almacen: 'SAGUNTO',
      motivos: ['rutaConsultada'],
      envios: [],
    });
    expect(onRutaDecaActualizada.mock.calls[0]?.[0].deca[0].estado).toBe('ENVIADO');
    expect(llamadas).toContain(`p_expRutasDeca:SELECT:${RUTA_EXACTA}`);
    expect(llamadas).toContain(`p_expRutasDeca:SELECT_ENVIOS:${RUTA_EXACTA}`);
  });

  it('con cliente de Docuten, descarga los documentos del shipmentId del DECA y los pasa al sink', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expedicionesAza') {
          return { status: 200, body: [{ id: '42', pedido: 'P1', estado: 'ASIGNADO', ruta: RUTA_EXACTA }] };
        }
        if (proc === 'p_expRutasDeca' && body.accion === 'SELECT') {
          return { status: 200, body: [{ shipmentReference: `${RUTA_EXACTA}-AZA`, estado: 'ENVIADO', shipmentId: 'SHIP-1' }] };
        }
        return { status: 200, body: [] };
      },
    });
    const descargarDocumentos = vi.fn(async (shipmentId: string) => [
      { shipmentId, variante: 'include-all' as const, url: 'u1', status: 200, ok: true, extension: 'zip', bytes: 3, datos: Buffer.from('abc') },
      { shipmentId, variante: 'simple' as const, url: 'u2', status: 404, ok: false, extension: 'bin', bytes: 0, error: 'no hay' },
    ]);
    const onRutaDecaActualizada = vi.fn();
    // Watcher con los servicios reales (contra el mock de LUX) y un cliente de Docuten simulado.
    const appConfig = buildTestConfig({ luxBaseUrl: baseUrl });
    const luxClient = new LuxClient(appConfig, new AuthManager(appConfig, createLogger('error')), createLogger('error'));
    const exp = new ExpedicionesService(luxClient);
    watcher = new LuxActionWatcher(
      config, luxClient, exp, new RecepcionesService(luxClient), createLogger('debug'),
      { onRutaDecaActualizada }, new RutasService(luxClient, exp), { descargarDocumentos },
    );
    watcher.start();
    await waitUntil(() => existsSync(join(config.stateDir, 'lux.state.json')) && existsSync(join(config.stateDir, 'lux-mobile.state.json')));

    appendFileSync(luxLogPath, lineaRuta('MMartosL'));

    await waitUntil(() => onRutaDecaActualizada.mock.calls.length > 0, 5000);
    expect(descargarDocumentos).toHaveBeenCalledWith('SHIP-1');
    const resultado = onRutaDecaActualizada.mock.calls[0]?.[0];
    expect(resultado.descargas).toHaveLength(2);
    expect(resultado.descargas.map((d: { variante: string; ok: boolean }) => [d.variante, d.ok])).toEqual([['include-all', true], ['simple', false]]);
  });

  /** Espera a que rutas-procesadas.json tenga `n` rutas anotadas (se escribe DESPUES de entregar al sink). */
  const esperarRegistro = async (n: number): Promise<void> => {
    await waitUntil(() => {
      try {
        return Object.keys(JSON.parse(readFileSync(join(config.stateDir, 'rutas-procesadas.json'), 'utf-8')).rutas ?? {}).length >= n;
      } catch {
        return false;
      }
    }, 8000);
  };

  describe('revision de arranque: lee lux.log.1 y lux.log.0 y procesa las consultas de ruta ya ocurridas', () => {
    const linea = (hora: string, ruta: string, usuario: string): string =>
      `05-oct-2026 ${hora} INFO:   [] exec p_expedicionesAza @extraMostrar='',@estado='',@tipo='',@generarDeca='',@fechaCerrado_FIN='',@ruta='%${ruta}%',@ALMACEN='SAGUNTO',@ACCION='SELECT',@USUARIO='${usuario}'\n`;

    const mockRutas = (llamadas: string[]) =>
      mock.updateOptions({
        onProc: (proc, body) => {
          if (proc === 'p_expedicionesAza') {
            const exacta = String(body.ruta).includes('AAA') ? 'RT_AAA_EXACTA' : 'RT_BBB_EXACTA';
            return { status: 200, body: [{ id: '1', pedido: 'P', ruta: exacta }] };
          }
          if (proc === 'p_expRutasDeca') {
            llamadas.push(`${body.accion}:${body.numeroRuta}`);
            return { status: 200, body: body.accion === 'SELECT' ? [{ shipmentReference: `${body.numeroRuta}-AZA`, estado: 'ENVIADO' }] : [] };
          }
          return { status: 404, body: { mensaje: 'no mockeado' } };
        },
      });

    it('procesa la ULTIMA consulta de cada ruta de ambos ficheros, ignora al usuario tecnico, y un segundo arranque NO repite nada', async () => {
      const llamadas: string[] = [];
      mockRutas(llamadas);
      // Antes de arrancar: consultas YA ocurridas, repartidas entre lux.log.1 (antiguo) y lux.log.0.
      writeFileSync(
        join(dir, 'lux.log.1'),
        linea('10:00:00', 'RT00001_AAA', 'MMartosL') + linea('10:05:00', 'RT00003_CCC', 'apiUser'),
      );
      writeFileSync(luxLogPath, linea('11:00:00', 'RT00001_AAA', 'MMartosL') + linea('11:30:00', 'RT00002_BBB', 'JCRedolarS'));

      const sink1 = vi.fn();
      watcher = buildWatcher({ onRutaDecaActualizada: sink1 });
      watcher.start();
      await waitUntil(() => sink1.mock.calls.length >= 2, 8000);
      await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.rutasArranque'), 8000);

      const numeros = sink1.mock.calls.map((c) => c[0].numeroRuta).sort();
      expect(numeros).toEqual(['RT_AAA_EXACTA', 'RT_BBB_EXACTA']); // una por ruta (la de apiUser no cuenta)
      const resumen = logLines.find((l) => l.operacion === 'watcher.rutasArranque');
      expect(resumen).toMatchObject({ consultasEncontradas: 3, rutasDistintas: 2, programadas: 2, yaProcesadas: 0 });
      expect(llamadas.filter((c) => c.startsWith('SELECT:'))).toHaveLength(2);
      await esperarRegistro(2);

      // Segundo arranque con el MISMO estado: ya estan hechas -> no se repite ninguna.
      await watcher.stop();
      llamadas.length = 0;
      logLines.length = 0;
      const sink2 = vi.fn();
      watcher = buildWatcher({ onRutaDecaActualizada: sink2 });
      watcher.start();
      await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.rutasArranque'), 8000);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(logLines.find((l) => l.operacion === 'watcher.rutasArranque')).toMatchObject({ rutasDistintas: 2, programadas: 0, yaProcesadas: 2 });
      expect(sink2).not.toHaveBeenCalled();
      expect(llamadas).toEqual([]);
    });

    it('una consulta NUEVA posterior a lo ya procesado si se procesa en el siguiente arranque', async () => {
      const llamadas: string[] = [];
      mockRutas(llamadas);
      writeFileSync(luxLogPath, linea('11:00:00', 'RT00001_AAA', 'MMartosL'));
      const sink1 = vi.fn();
      watcher = buildWatcher({ onRutaDecaActualizada: sink1 });
      watcher.start();
      await waitUntil(() => sink1.mock.calls.length >= 1, 8000);
      await esperarRegistro(1);
      await watcher.stop();

      // Mientras estaba parado alguien vuelve a consultar la ruta (varias horas despues).
      appendFileSync(luxLogPath, linea('15:30:00', 'RT00001_AAA', 'MMartosL'));
      logLines.length = 0;
      const sink2 = vi.fn();
      watcher = buildWatcher({ onRutaDecaActualizada: sink2 });
      watcher.start();
      await waitUntil(() => sink2.mock.calls.length >= 1, 8000);

      expect(sink2.mock.calls[0]?.[0].numeroRuta).toBe('RT_AAA_EXACTA');
    });
  });

  describe('GENERAR_DECA: el DECA se registra cuando se genera, aunque la ruta nunca se consultara en pantalla', () => {
    const lineaGenerar = (hora: string, id: string, usuario = 'MPeiroZ'): string =>
      `05-oct-2026 ${hora} INFO:   [] exec p_expRutas @accion='GENERAR_DECA',@almacen='ALMUSSAFES',@usuario='${usuario}',@id='${id}'\n`;
    const mockPorId = (llamadas: string[]) =>
      mock.updateOptions({
        onProc: (proc, body) => {
          if (proc === 'p_expRutasDeca') {
            llamadas.push(`${body.accion}:${body.id ?? body.numeroRuta}`);
            return { status: 200, body: body.accion === 'SELECT' ? [{ shipmentReference: `RT${body.id}_2026_X-AZA`, estado: 'ENVIADO', shipmentId: `SH-${body.id}` }] : [] };
          }
          return { status: 404, body: { mensaje: 'no mockeado' } };
        },
      });

    it('en vivo: consulta p_expRutasDeca por el id de la ruta y entrega el DECA al sink (con almacen y documentos)', async () => {
      const llamadas: string[] = [];
      mockPorId(llamadas);
      const onRutaDecaActualizada = vi.fn();
      const descargarDocumentos = vi.fn(async (shipmentId: string) => [
        { shipmentId, variante: 'include-all' as const, url: 'u', status: 200, ok: true, extension: 'json', bytes: 1 },
      ]);
      const appConfig = buildTestConfig({ luxBaseUrl: baseUrl });
      const luxClient = new LuxClient(appConfig, new AuthManager(appConfig, createLogger('error')), createLogger('error'));
      const exp = new ExpedicionesService(luxClient);
      watcher = new LuxActionWatcher(config, luxClient, exp, new RecepcionesService(luxClient), createLogger('debug'), { onRutaDecaActualizada }, new RutasService(luxClient, exp), { descargarDocumentos });
      watcher.start();
      await waitUntil(() => existsSync(join(config.stateDir, 'lux.state.json')) && existsSync(join(config.stateDir, 'lux-mobile.state.json')));

      appendFileSync(luxLogPath, lineaGenerar('14:48:51', '14764'));

      await waitUntil(() => onRutaDecaActualizada.mock.calls.length > 0, 10000);
      const r = onRutaDecaActualizada.mock.calls[0]?.[0];
      expect(r).toMatchObject({ numeroRuta: 'RT14764_2026_X', almacen: 'ALMUSSAFES', motivos: ['decaGenerada'], consultaOriginal: 'GENERAR_DECA id=14764' });
      expect(descargarDocumentos).toHaveBeenCalledWith('SH-14764');
      expect(llamadas).toContain('SELECT:14764');
    });

    it('la revision de arranque del DECA lee tambien lux.log.2 (revisarFicherosDeca=3) pero NO con 2', async () => {
      const llamadas: string[] = [];
      mockPorId(llamadas);
      writeFileSync(join(dir, 'lux.log.2'), lineaGenerar('08:01:36', '14781')); // evento antiguo, solo en el .2
      writeFileSync(join(dir, 'lux.log.1'), lineaGenerar('13:43:42', '14791'));
      writeFileSync(luxLogPath, '');
      const valorOriginal = config.revisarFicherosDeca;
      try {
        // Con 2 ficheros (.0 y .1) el evento del .2 queda fuera.
        config.revisarFicherosDeca = 2;
        const sinDos = vi.fn();
        watcher = buildWatcher({ onRutaDecaActualizada: sinDos });
        watcher.start();
        await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.rutasArranque'), 8000);
        await waitUntil(() => sinDos.mock.calls.length >= 1, 8000);
        expect(sinDos.mock.calls.map((c) => c[0].numeroRuta)).toEqual(['RT14791_2026_X']);
        await watcher.stop();

        // Con 3 entra tambien el .2 (registro nuevo: el estado anterior no marca el 14781).
        rmSync(join(config.stateDir, 'rutas-procesadas.json'), { force: true });
        config.revisarFicherosDeca = 3;
        logLines.length = 0;
        const conTres = vi.fn();
        watcher = buildWatcher({ onRutaDecaActualizada: conTres });
        watcher.start();
        await waitUntil(() => conTres.mock.calls.length >= 2, 10000);
        expect(conTres.mock.calls.map((c) => c[0].numeroRuta).sort()).toEqual(['RT14781_2026_X', 'RT14791_2026_X']);
        expect(logLines.find((l) => l.operacion === 'watcher.rutasArranque')).toMatchObject({ ficherosLeidos: 4 }); // LUX .2 + .1 + .0, y el .0 de LUX_mobile
      } finally {
        config.revisarFicherosDeca = valorOriginal;
      }
    });

    it('al arrancar: lee lux.log.1 y lux.log.0, procesa el ultimo GENERAR_DECA de cada ruta y un segundo arranque no repite', async () => {
      const llamadas: string[] = [];
      mockPorId(llamadas);
      writeFileSync(join(dir, 'lux.log.1'), lineaGenerar('13:43:42', '14791') + lineaGenerar('14:00:00', '14791'));
      writeFileSync(luxLogPath, lineaGenerar('15:26:45', '14802', 'JmartinezA'));

      const sink1 = vi.fn();
      watcher = buildWatcher({ onRutaDecaActualizada: sink1 });
      watcher.start();
      await waitUntil(() => sink1.mock.calls.length >= 2, 10000);
      expect(sink1.mock.calls.map((c) => c[0].numeroRuta).sort()).toEqual(['RT14791_2026_X', 'RT14802_2026_X']);
      expect(llamadas.filter((c) => c.startsWith('SELECT:'))).toHaveLength(2); // 14791 solo una vez (ultimo evento)
      await esperarRegistro(2);

      await watcher.stop();
      logLines.length = 0;
      llamadas.length = 0;
      const sink2 = vi.fn();
      watcher = buildWatcher({ onRutaDecaActualizada: sink2 });
      watcher.start();
      await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.rutasArranque'), 8000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(logLines.find((l) => l.operacion === 'watcher.rutasArranque')).toMatchObject({ rutasDistintas: 2, programadas: 0, yaProcesadas: 2 });
      expect(sink2).not.toHaveBeenCalled();
      expect(llamadas).toEqual([]);
    });
  });

  it('ignora las consultas de ruta hechas por el propio watcher (usuario tecnico): sin bucle', async () => {
    const llamadas = mockDeca();
    const onRutaDecaActualizada = vi.fn();
    await startAndWaitBaseline({ onRutaDecaActualizada });

    appendFileSync(luxLogPath, lineaRuta('apiUser'));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(onRutaDecaActualizada).not.toHaveBeenCalled();
    expect(llamadas).toEqual([]);
  });

  it('una ruta sin DECA ni envios no genera registro en el sink', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expedicionesAza') {
          return { status: 200, body: [{ id: '42', pedido: 'P1', ruta: RUTA_EXACTA }] };
        }
        if (proc === 'p_expRutasDeca') {
          return { status: 200, body: body.accion === 'SELECT' ? [] : '' };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });
    const onRutaDecaActualizada = vi.fn();
    await startAndWaitBaseline({ onRutaDecaActualizada });

    appendFileSync(luxLogPath, lineaRuta('MMartosL'));
    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.rutaDecaConsultada'), 5000);

    expect(onRutaDecaActualizada).not.toHaveBeenCalled();
  });

  it('si el sink falla, el refresco ya registrado en el log no se ve afectado (se registra watcher.sinkError aparte)', async () => {
    mock.updateOptions({
      onProc: (proc, body) => {
        if (proc === 'p_expCabeceraAza' && body.accion === 'SELECT_ONE') {
          return { status: 200, body: [{ mensaje: 'OK', idPedido: '11115', pedido: 'EXP0000074' }] };
        }
        if (proc === 'p_expedicionesAza' && body.accion === 'SELECT') {
          return { status: 200, body: [{ id: '11115', pedido: 'EXP0000074', propietario: 'AZA LOGISTICS SLU', estado: 'CERRADO' }] };
        }
        return { status: 404, body: { mensaje: 'no mockeado' } };
      },
    });

    const onExpedicionActualizada = vi.fn().mockRejectedValue(new Error('BD no disponible'));
    await startAndWaitBaseline({ onExpedicionActualizada });

    appendFileSync(
      luxLogPath,
      "30-sep-2026 12:46:48 INFO:   [] exec p_expediciones @accion='CERRAR_OFICINA_FIN_FORZAR',@almacen='SAGUNTO',@usuario='JIbanezM',@id='11115'\n",
    );

    await waitUntil(() => logLines.some((l) => l.operacion === 'watcher.sinkError'));
    expect(logLines.some((l) => l.operacion === 'watcher.pedidoActualizado' && l.resultado === 'OK')).toBe(true);
    const errorLine = logLines.find((l) => l.operacion === 'watcher.sinkError');
    expect(errorLine).toMatchObject({ resultado: 'ERROR', dominio: 'expedicion', error: 'BD no disponible' });
  });
});
