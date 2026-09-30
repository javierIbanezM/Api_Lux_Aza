import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../../src/logging';
import { createJsonFileSink } from '../../src/watcher/jsonFileSink';
import type { ExpedicionActualizada, AlbaranActualizado } from '../../src/watcher/watcherSink';

describe('watcher/jsonFileSink', () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('crea la carpeta si no existe y guarda un JSON por evento de expedicion con toda la informacion', async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'watcher-json-')), 'sub', 'events');
    const sink = createJsonFileSink(dir, createLogger('error'));

    const result: ExpedicionActualizada = {
      idPedido: '11122',
      pedido: 'EXP0000078',
      propietario: 'FARMALIDER',
      estado: 'PENDIENTE',
      motivos: ['expedicionCabeceraActualizada'],
      cabecera: { mensaje: 'OK', idPedido: '11122', pedido: 'EXP0000078' },
      lineas: [{ mensaje: 'OK', id: '55231', referencia: '0260200002' }],
      contenedores: [],
    };

    await sink.onExpedicionActualizada?.(result);

    const ficheros = readdirSync(dir);
    expect(ficheros).toHaveLength(1);
    // El timestamp va PRIMERO en el nombre (para que el orden alfabetico sea cronologico), no al final.
    expect(ficheros[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*--expedicion-EXP0000078\.json$/);

    const contenido = JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8'));
    expect(contenido).toEqual(result);
  });

  it('guarda un JSON por evento de recepcion, con nombre distinto al de expedicion', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));

    const result: AlbaranActualizado = {
      idAlbaran: '7838',
      albaran: 'REC0000068',
      propietario: 'FARMALIDER',
      estado: 'PTE. RECEPCION',
      motivos: ['recepcionCerradaPicking'],
      cabecera: { mensaje: 'OK', idAlbaran: '7838', albaran: 'REC0000068' },
      lineas: [],
      hus: [],
    };

    await sink.onAlbaranActualizado?.(result);

    const ficheros = readdirSync(dir);
    expect(ficheros).toHaveLength(1);
    expect(ficheros[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*--recepcion-REC0000068\.json$/);

    const contenido = JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8'));
    expect(contenido).toEqual(result);
  });

  it('dos eventos seguidos del mismo pedido dejan solo UN fichero, el mas reciente (se borra el anterior)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));

    const base: ExpedicionActualizada = {
      idPedido: '11122',
      pedido: 'EXP0000078',
      propietario: 'FARMALIDER',
      estado: 'PENDIENTE',
      motivos: ['expedicionLineaModificada'],
      lineas: [],
      contenedores: [],
    };

    await sink.onExpedicionActualizada?.(base);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.onExpedicionActualizada?.({ ...base, estado: 'ASIGNADO', motivos: ['expedicionPasadaAlmacen'] });

    const ficheros = readdirSync(dir);
    expect(ficheros).toHaveLength(1);
    const contenido = JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8'));
    expect(contenido.estado).toBe('ASIGNADO'); // el mas reciente, no el primero
  });

  it('lo mismo para recepciones: solo queda el JSON mas reciente del mismo albaran', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));

    const base: AlbaranActualizado = {
      idAlbaran: '7838',
      albaran: 'REC0000068',
      propietario: 'FARMALIDER',
      estado: 'CREACION',
      motivos: ['recepcionCabeceraActualizada'],
      lineas: [],
      hus: [],
    };

    await sink.onAlbaranActualizado?.(base);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.onAlbaranActualizado?.({ ...base, estado: 'PTE. RECEPCION', motivos: ['recepcionPasadaAlmacen'] });

    const ficheros = readdirSync(dir);
    expect(ficheros).toHaveLength(1);
    const contenido = JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8'));
    expect(contenido.estado).toBe('PTE. RECEPCION');
  });

  it('al llegar a estado ENVIADO, borra todos los JSON previos del pedido y no guarda uno nuevo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));

    const base: ExpedicionActualizada = {
      idPedido: '11122',
      pedido: 'EXP0000078',
      propietario: 'FARMALIDER',
      estado: 'PENDIENTE',
      motivos: ['expedicionCabeceraActualizada'],
      lineas: [],
      contenedores: [],
    };

    await sink.onExpedicionActualizada?.(base);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.onExpedicionActualizada?.({ ...base, estado: 'ASIGNADO', motivos: ['expedicionPasadaAlmacen'] });
    expect(readdirSync(dir)).toHaveLength(1); // confirma que habia algo que borrar

    await sink.onExpedicionActualizada?.({ ...base, estado: 'ENVIADO', motivos: ['expedicionCerradaOficina'] });

    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('ENVIADO de un pedido no afecta a los JSON de otro pedido distinto', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));

    await sink.onExpedicionActualizada?.({
      idPedido: '11122',
      pedido: 'EXP0000078',
      propietario: 'FARMALIDER',
      estado: 'PENDIENTE',
      motivos: ['expedicionCabeceraActualizada'],
      lineas: [],
      contenedores: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.onExpedicionActualizada?.({
      idPedido: '11115',
      pedido: 'EXP0000074',
      propietario: 'AZA LOGISTICS SLU',
      estado: 'ENVIADO',
      motivos: ['expedicionCerradaOficina'],
      lineas: [],
      contenedores: [],
    });

    const ficheros = readdirSync(dir);
    expect(ficheros).toHaveLength(1);
    expect(ficheros[0]).toMatch(/--expedicion-EXP0000078\.json$/);
  });

  it('el orden alfabetico de los nombres de fichero coincide con el orden cronologico de creacion', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));

    // 3 pedidos DISTINTOS (para que ninguno se borre por el dedup) creados en orden, con nombres
    // de pedido que alfabeticamente irian al reves (Z, M, A) si no fuera por el timestamp delante.
    await sink.onExpedicionActualizada?.({
      idPedido: '1', pedido: 'ZETA', propietario: 'X', estado: 'PENDIENTE', motivos: ['expedicionCabeceraActualizada'], lineas: [], contenedores: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.onExpedicionActualizada?.({
      idPedido: '2', pedido: 'EME', propietario: 'X', estado: 'PENDIENTE', motivos: ['expedicionCabeceraActualizada'], lineas: [], contenedores: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.onExpedicionActualizada?.({
      idPedido: '3', pedido: 'ALFA', propietario: 'X', estado: 'PENDIENTE', motivos: ['expedicionCabeceraActualizada'], lineas: [], contenedores: [],
    });

    const ficheros = readdirSync(dir); // readdirSync ya devuelve en orden alfabetico
    expect(ficheros).toHaveLength(3);
    expect(ficheros[0]).toMatch(/--expedicion-ZETA\.json$/);
    expect(ficheros[1]).toMatch(/--expedicion-EME\.json$/);
    expect(ficheros[2]).toMatch(/--expedicion-ALFA\.json$/);
  });

  it('ENVIADO sin ficheros previos en disco no falla (carpeta ya vacia o inexistente)', async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'watcher-json-')), 'no-creada-aun');
    const sink = createJsonFileSink(dir, createLogger('error'));

    await expect(
      sink.onExpedicionActualizada?.({
        idPedido: '11122',
        pedido: 'EXP0000078',
        propietario: 'FARMALIDER',
        estado: 'ENVIADO',
        motivos: ['expedicionCerradaOficina'],
        lineas: [],
        contenedores: [],
      }),
    ).resolves.toBeUndefined();
  });
});
