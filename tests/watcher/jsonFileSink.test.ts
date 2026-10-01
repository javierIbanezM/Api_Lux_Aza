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

describe('watcher/jsonFileSink estados finales y destino', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const albaran = (estado: string): AlbaranActualizado => ({
    idAlbaran: '7838',
    albaran: 'REC0000068',
    estado,
    motivos: ['recepcionCerradaPicking'],
    lineas: [],
    hus: [],
  });
  const expedicion = (estado: string): ExpedicionActualizada => ({
    idPedido: '1',
    pedido: 'EXP1',
    estado,
    motivos: ['expedicionCabeceraActualizada'],
    lineas: [],
    contenedores: [],
  });

  it('recepcion CERRADO borra los JSON previos y no guarda uno nuevo (sin destino)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const sink = createJsonFileSink(dir, createLogger('error'));
    await sink.onAlbaranActualizado?.(albaran('PENDIENTE'));
    expect(readdirSync(dir)).toHaveLength(1);
    await sink.onAlbaranActualizado?.(albaran('CERRADO'));
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('con destino, borra el JSON solo despues de que el destino confirme', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const guardados: string[] = [];
    const destino = {
      guardarExpedicion: async (r: ExpedicionActualizada) => void guardados.push(`exp:${r.estado}`),
      guardarAlbaran: async (r: AlbaranActualizado) => void guardados.push(`alb:${r.estado}`),
    };
    const sink = createJsonFileSink(dir, createLogger('error'), destino);
    await sink.onAlbaranActualizado?.(albaran('PENDIENTE'));
    await sink.onExpedicionActualizada?.(expedicion('ASIGNADO'));
    expect(guardados).toEqual([]); // no final: el destino no interviene
    await sink.onAlbaranActualizado?.(albaran('CERRADO'));
    await sink.onExpedicionActualizada?.(expedicion('ENVIADO'));
    expect(guardados).toEqual(['alb:CERRADO', 'exp:ENVIADO']);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('con destino que falla, conserva el JSON mas actual y no lanza', async () => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const destino = {
      guardarExpedicion: async () => {
        throw new Error('BD caida');
      },
      guardarAlbaran: async () => {
        throw new Error('BD caida');
      },
    };
    const sink = createJsonFileSink(dir, createLogger('error'), destino);
    await sink.onAlbaranActualizado?.(albaran('PENDIENTE'));
    await expect(sink.onAlbaranActualizado?.(albaran('CERRADO'))).resolves.toBeUndefined();
    const ficheros = readdirSync(dir);
    expect(ficheros).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8')).estado).toBe('CERRADO');
  });
});

describe('watcher/jsonFileSink ruta enviada sin pedidos', () => {
  it('guarda un JSON por ruta y reemplaza el anterior de la misma ruta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(dir, createLogger('error'));
      const base = { idRuta: '14586', almacen: 'SAGUNTO', terminal: 'abc', pedidos: [] as string[] };
      await sink.onRutaEnviadaSinPedidos?.({ ...base, detectadoEn: '2026-10-01T16:56:37.000Z' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sink.onRutaEnviadaSinPedidos?.({ ...base, detectadoEn: '2026-10-01T16:57:00.000Z' });

      const ficheros = readdirSync(dir);
      expect(ficheros).toHaveLength(1);
      expect(ficheros[0]).toMatch(/--ruta-14586\.json$/);
      const contenido = JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8'));
      expect(contenido).toMatchObject({ idRuta: '14586', pedidos: [], detectadoEn: '2026-10-01T16:57:00.000Z' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('watcher/jsonFileSink eventos simultaneos del mismo albaran', () => {
  it('deja un unico JSON aunque lleguen varios eventos a la vez', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(dir, createLogger('error'));
      const base: AlbaranActualizado = {
        idAlbaran: '1',
        albaran: 'DKSH_161017914',
        estado: 'RECEPCION',
        motivos: ['recepcionLineaConfirmada'],
        lineas: [],
        hus: [],
      };
      await Promise.all([
        sink.onAlbaranActualizado?.({ ...base, estado: 'PENDIENTE' }),
        sink.onAlbaranActualizado?.({ ...base, estado: 'RECEPCION' }),
        sink.onAlbaranActualizado?.({ ...base, estado: 'ASIGNADO' }),
      ]);
      const ficheros = readdirSync(dir);
      expect(ficheros).toHaveLength(1);
      // El ultimo en llegar es el que se queda.
      expect(JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8')).estado).toBe('ASIGNADO');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
