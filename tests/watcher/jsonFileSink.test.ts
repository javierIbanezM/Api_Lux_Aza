import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

describe('watcher/jsonFileSink DECA de rutas', () => {
  const consulta = {
    filtroLog: '%RT00013615_2026_COMP %',
    metodoResolucion: 'listado' as const,
    llamadas: [
      { procedimiento: 'p_expRutasDeca', accion: 'SELECT', parametros: { numeroRuta: 'RT00013615_2026_COMP MAMENTRANS007 S.L.' }, almacen: 'SAGUNTO', filas: 1 },
    ],
  };
  const base = {
    numeroRuta: 'RT00013615_2026_COMP MAMENTRANS007 S.L.',
    consultaOriginal: '%RT00013615_2026_COMP %',
    almacen: 'SAGUNTO',
    motivos: ['rutaConsultada' as const],
    consulta,
    envios: [],
  };
  const deca = (estado: string) => [{ shipmentReference: 'RT-AZA', estado } as never];
  const CARPETA_RUTA = 'RT00013615_2026_COMP_MAMENTRANS007_S_L_';

  it('guarda en una CARPETA POR RUTA el JSON (consulta a la API + datos) y reemplaza el anterior', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const eventos = join(raiz, 'events');
    const rutas = join(raiz, 'rutas-deca');
    try {
      const sink = createJsonFileSink(eventos, createLogger('error'), undefined, rutas);
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: '2026-10-05T08:00:00Z', deca: deca('PENDIENTE'), descargas: [] });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: '2026-10-05T08:05:00Z', deca: deca('ENVIADO'), descargas: [] });

      expect(readdirSync(rutas)).toEqual([CARPETA_RUTA]); // la carpeta lleva el nombre de la ruta
      const ficheros = readdirSync(join(rutas, CARPETA_RUTA));
      expect(ficheros).toHaveLength(1);
      expect(ficheros[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*--rutadeca-RT00013615_2026_COMP_MAMENTRANS007_S_L_\.json$/);
      const contenido = JSON.parse(readFileSync(join(rutas, CARPETA_RUTA, ficheros[0] as string), 'utf-8'));
      expect(contenido.deca[0].estado).toBe('ENVIADO'); // los datos
      expect(contenido.consulta.llamadas[0]).toMatchObject({ procedimiento: 'p_expRutasDeca', accion: 'SELECT', parametros: { numeroRuta: base.numeroRuta } }); // la consulta
      expect(existsSync(eventos)).toBe(false); // la carpeta de eventos no se toca
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('guarda en la carpeta de la ruta los documentos de Docuten (PDF decodificado, con su nombre) sin duplicar los identicos, y deja solo metadatos en el JSON', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      const pdf = Buffer.from('%PDF-1.4 porte');
      const doc = { fileName: 'Porte ruta RT00013615_2026_COMP MAMENTRANS007 S.L. -AZA.pdf', documentType: 'transport_control_document', bytes: pdf.length, datos: pdf };
      const descarga = (variante: 'include-all' | 'simple') => ({
        shipmentId: 'SHIP-1', variante, url: `https://x/${variante}`, status: 200, ok: true, extension: 'json', bytes: 999, documentos: [doc],
      });
      await sink.onRutaDecaActualizada?.({
        ...base,
        consultadoEn: '2026-10-05T08:00:00Z',
        deca: deca('ENVIADO'),
        // Las dos llamadas devuelven el MISMO documento (caso real de Docuten) + una que falla.
        descargas: [
          descarga('include-all'),
          descarga('simple'),
          { shipmentId: 'SHIP-2', variante: 'simple', url: 'https://x/2', status: 404, ok: false, extension: 'bin', bytes: 0, error: 'no hay documentos' },
        ],
      });

      const dir = join(raiz, CARPETA_RUTA);
      const nombres = readdirSync(dir).sort();
      expect(nombres).toHaveLength(2); // el JSON + UN solo PDF (no dos copias iguales)
      expect(nombres).toContain(doc.fileName);
      expect(readFileSync(join(dir, doc.fileName)).equals(pdf)).toBe(true);

      const json = JSON.parse(readFileSync(join(dir, nombres.find((n) => n.endsWith('.json')) as string), 'utf-8'));
      expect(json.descargas).toHaveLength(3);
      expect(json.descargas[0]).toMatchObject({ variante: 'include-all', ok: true, status: 200, ficheros: [{ fichero: doc.fileName, documentType: 'transport_control_document', bytes: pdf.length }] });
      expect(json.descargas[1].ficheros[0].fichero).toBe(doc.fileName); // apunta al mismo fichero
      expect(json.descargas[0].documentos).toBeUndefined(); // el contenido NO va dentro del JSON
      expect(json.descargas[2]).toMatchObject({ ok: false, status: 404, error: 'no hay documentos', ficheros: [] });
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('si dos documentos tienen el mismo nombre pero contenido distinto, no se pisan (se distingue por la variante)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      const mk = (txt: string) => ({ fileName: 'Porte.pdf', bytes: txt.length, datos: Buffer.from(txt) });
      const d = (variante: 'include-all' | 'simple', txt: string) => ({
        shipmentId: 'S', variante, url: 'u', status: 200, ok: true, extension: 'json', bytes: 1, documentos: [mk(txt)],
      });
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: 't', deca: deca('X'), descargas: [d('include-all', 'AAAA'), d('simple', 'BBBB')] });
      const pdfs = readdirSync(join(raiz, CARPETA_RUTA)).filter((n) => n.endsWith('.pdf')).sort();
      expect(pdfs).toEqual(['Porte (simple).pdf', 'Porte.pdf']);
      expect(readFileSync(join(raiz, CARPETA_RUTA, 'Porte.pdf'), 'utf-8')).toBe('AAAA');
      expect(readFileSync(join(raiz, CARPETA_RUTA, 'Porte (simple).pdf'), 'utf-8')).toBe('BBBB');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
