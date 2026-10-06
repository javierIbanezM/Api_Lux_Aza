import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const sink = createJsonFileSink(dir, createLogger('error'), undefined, undefined, { borrarFinales: true });

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
    const sink = createJsonFileSink(dir, createLogger('error'), undefined, undefined, { borrarFinales: true });

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
    const sink = createJsonFileSink(dir, createLogger('error'), undefined, undefined, { borrarFinales: true });

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
    const sink = createJsonFileSink(dir, createLogger('error'), undefined, undefined, { borrarFinales: true });
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
    const sink = createJsonFileSink(dir, createLogger('error'), destino, undefined, { borrarFinales: true });
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
    const sink = createJsonFileSink(dir, createLogger('error'), destino, undefined, { borrarFinales: true });
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
  const deca = (estado: string) => [{ shipmentReference: 'RT-AZA', estado, fechaCreacion: '05/10/2026 17:25:02' } as never];
  const CARPETA_RUTA = 'RT00013615_2026_COMP_MAMENTRANS007_S_L_';
  /** Carpeta real de la ruta: `<fecha>--<ruta>` (la fecha, la de creacion del DECA, va delante). */
  const dirRuta = (raiz: string): string => join(raiz, readdirSync(raiz).find((n) => n.endsWith(`--${CARPETA_RUTA}`)) as string);

  it('guarda en una CARPETA POR RUTA el JSON (consulta a la API + datos) y reemplaza el anterior', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    const eventos = join(raiz, 'events');
    const rutas = join(raiz, 'rutas-deca');
    try {
      const sink = createJsonFileSink(eventos, createLogger('error'), undefined, rutas);
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: '2026-10-05T08:00:00Z', deca: deca('PENDIENTE'), descargas: [] });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: '2026-10-05T08:05:00Z', deca: deca('ENVIADO'), descargas: [] });

      expect(readdirSync(rutas)).toEqual([`2026-10-05T17-25-02--${CARPETA_RUTA}`]); // fecha de creacion del DECA + nombre de la ruta
      const ficheros = readdirSync(dirRuta(rutas));
      expect(ficheros).toHaveLength(1);
      expect(ficheros[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*--rutadeca-RT00013615_2026_COMP_MAMENTRANS007_S_L_\.json$/);
      const contenido = JSON.parse(readFileSync(join(dirRuta(rutas), ficheros[0] as string), 'utf-8'));
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

      const dir = dirRuta(raiz);
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

  it('una ruta con VARIOS envios DECA (mismo nombre de PDF): cada fichero lleva el id y el estado de su envio y ninguno pisa a otro', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      const mk = (txt: string) => ({ fileName: 'Porte ruta RT1-AZA.pdf', bytes: txt.length, datos: Buffer.from(txt) });
      const d = (shipmentId: string, variante: 'include-all' | 'simple', txt: string) => ({
        shipmentId, variante, url: 'u', status: 200, ok: true, extension: 'json', bytes: 1, documentos: [mk(txt)],
      });
      await sink.onRutaDecaActualizada?.({
        ...base,
        consultadoEn: 't',
        deca: [
          { shipmentReference: 'RT1-AZA', estado: 'ANULADO', shipmentId: 'aaaaaaaa-1' } as never,
          { shipmentReference: 'RT1-AZA', estado: 'ANULADO', shipmentId: 'bbbbbbbb-2' } as never,
          { shipmentReference: 'RT1-AZA', estado: 'FIRMADO', shipmentId: 'cccccccc-3' } as never,
        ],
        // 3 envios, el mismo nombre de PDF y contenido distinto en cada uno; cada envio devuelve lo mismo en las 2 variantes.
        descargas: [
          d('aaaaaaaa-1', 'include-all', 'UNO'), d('aaaaaaaa-1', 'simple', 'UNO'),
          d('bbbbbbbb-2', 'include-all', 'DOS'), d('bbbbbbbb-2', 'simple', 'DOS'),
          d('cccccccc-3', 'include-all', 'TRES'), d('cccccccc-3', 'simple', 'TRES'),
        ],
      });
      const pdfs = readdirSync(dirRuta(raiz)).filter((n) => n.endsWith('.pdf')).sort();
      expect(pdfs).toEqual([
        'Porte ruta RT1-AZA [aaaaaaaa ANULADO].pdf',
        'Porte ruta RT1-AZA [bbbbbbbb ANULADO].pdf',
        'Porte ruta RT1-AZA [cccccccc FIRMADO].pdf',
      ]);
      expect(readFileSync(join(dirRuta(raiz), pdfs[0] as string), 'utf-8')).toBe('UNO');
      expect(readFileSync(join(dirRuta(raiz), pdfs[1] as string), 'utf-8')).toBe('DOS');
      expect(readFileSync(join(dirRuta(raiz), pdfs[2] as string), 'utf-8')).toBe('TRES');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('retira los PDF de pasadas anteriores que ya no corresponden (nombres antiguos), sin tocar nada si la descarga fallo', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      const antigua = join(raiz, CARPETA_RUTA); // carpeta del esquema antiguo (sin fecha)
      mkdirSync(antigua, { recursive: true });
      writeFileSync(join(antigua, 'Porte ruta RT1-AZA (simple).pdf'), 'VIEJO'); // esquema antiguo
      const doc = { fileName: 'Porte ruta RT1-AZA.pdf', bytes: 4, datos: Buffer.from('NUEVO') };
      const ok = { shipmentId: 'S1', variante: 'include-all' as const, url: 'u', status: 200, ok: true, extension: 'json', bytes: 1, documentos: [doc] };
      const fallo = { shipmentId: 'S1', variante: 'include-all' as const, url: 'u', status: 401, ok: false, extension: 'bin', bytes: 0, error: 'sin permiso' };

      // Descarga fallida: los ficheros existentes se conservan.
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: 't', deca: deca('ENVIADO'), descargas: [fallo] });
      const dir = dirRuta(raiz); // la carpeta antigua se renombro con la fecha, conservando su contenido
      expect(readdirSync(dir).filter((n) => n.endsWith('.pdf'))).toEqual(['Porte ruta RT1-AZA (simple).pdf']);
      expect(existsSync(antigua)).toBe(false);

      // Descarga correcta: queda solo lo actual.
      await sink.onRutaDecaActualizada?.({ ...base, consultadoEn: 't2', deca: deca('ENVIADO'), descargas: [ok] });
      expect(readdirSync(dir).filter((n) => n.endsWith('.pdf'))).toEqual(['Porte ruta RT1-AZA.pdf']);
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
      const pdfs = readdirSync(dirRuta(raiz)).filter((n) => n.endsWith('.pdf')).sort();
      expect(pdfs).toEqual(['Porte (simple).pdf', 'Porte.pdf']);
      expect(readFileSync(join(dirRuta(raiz), 'Porte.pdf'), 'utf-8')).toBe('AAAA');
      expect(readFileSync(join(dirRuta(raiz), 'Porte (simple).pdf'), 'utf-8')).toBe('BBBB');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('watcher/jsonFileSink: por defecto NO se borra por estado final (conserva el mas reciente)', () => {
  it('expedicion ENVIADO: se guarda el JSON y se conserva; un nuevo evento reemplaza solo al anterior del mismo pedido', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(dir, createLogger('error'));
      const base: ExpedicionActualizada = { idPedido: '1', pedido: 'EXP1', estado: 'ASIGNADO', motivos: ['expedicionCabeceraActualizada'], lineas: [], contenedores: [] };
      await sink.onExpedicionActualizada?.(base);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sink.onExpedicionActualizada?.({ ...base, estado: 'ENVIADO', motivos: ['expedicionCerradaOficina'] });

      const ficheros = readdirSync(dir);
      expect(ficheros).toHaveLength(1); // uno por pedido
      expect(JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8')).estado).toBe('ENVIADO'); // el mas reciente
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preaviso CERRADO: tambien se conserva el JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(dir, createLogger('error'));
      const base: AlbaranActualizado = { idAlbaran: '7', albaran: 'REC1', estado: 'PENDIENTE', motivos: ['recepcionCerradaPicking'], lineas: [], hus: [] };
      await sink.onAlbaranActualizado?.(base);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sink.onAlbaranActualizado?.({ ...base, estado: 'CERRADO' });

      const ficheros = readdirSync(dir);
      expect(ficheros).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, ficheros[0] as string), 'utf-8')).estado).toBe('CERRADO');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('con destino configurado pero sin borrado por estado final, el destino no interviene y el JSON se conserva', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const guardados: string[] = [];
      const destino = {
        guardarExpedicion: async (r: ExpedicionActualizada) => void guardados.push(`exp:${r.estado}`),
        guardarAlbaran: async (r: AlbaranActualizado) => void guardados.push(`alb:${r.estado}`),
      };
      const sink = createJsonFileSink(dir, createLogger('error'), destino);
      await sink.onExpedicionActualizada?.({ idPedido: '1', pedido: 'EXP1', estado: 'ENVIADO', motivos: ['expedicionCerradaOficina'], lineas: [], contenedores: [] });
      expect(guardados).toEqual([]);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('watcher/jsonFileSink: mismo numero de pedido/albaran con distinto id (distinto propietario)', () => {
  const exp = (idPedido: string, propietario: string, estado = 'ASIGNADO') =>
    ({ idPedido, pedido: '05102026', almacen: 'SAGUNTO', propietario, estado, motivos: ['expedicionCabeceraActualizada' as const], lineas: [], contenedores: [] }) as never;

  it('dos pedidos con el mismo numero no se pisan: cada uno conserva su JSON (el segundo con sufijo _<id>)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      await sink.onExpedicionActualizada?.(exp('43180', 'ANDRANIS'));
      await sink.onExpedicionActualizada?.(exp('43360', 'AMARI'));
      const leer = (n: string) => JSON.parse(readFileSync(join(raiz, 'events', n), 'utf-8'));
      const nombres = readdirSync(join(raiz, 'events')).sort();
      expect(nombres).toHaveLength(2);
      expect(nombres.some((n) => n.endsWith('--expedicion-05102026.json'))).toBe(true);
      expect(nombres.some((n) => n.endsWith('--expedicion-05102026_43360.json'))).toBe(true);
      expect(nombres.map((n) => leer(n).idPedido).sort()).toEqual(['43180', '43360']);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('nuevos eventos de cada pedido reemplazan SU json (siguen siendo 2 ficheros, sin duplicados)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      await sink.onExpedicionActualizada?.(exp('43180', 'ANDRANIS'));
      await sink.onExpedicionActualizada?.(exp('43360', 'AMARI'));
      await sink.onExpedicionActualizada?.(exp('43180', 'ANDRANIS', 'CERRADO'));
      await sink.onExpedicionActualizada?.(exp('43360', 'AMARI', 'CERRADO'));
      const nombres = readdirSync(join(raiz, 'events'));
      expect(nombres).toHaveLength(2);
      for (const n of nombres) {
        expect(JSON.parse(readFileSync(join(raiz, 'events', n), 'utf-8')).estado).toBe('CERRADO');
      }
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('eventos SIMULTANEOS de los dos pedidos tampoco se pisan', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      await Promise.all([sink.onExpedicionActualizada?.(exp('43180', 'ANDRANIS')), sink.onExpedicionActualizada?.(exp('43360', 'AMARI'))]);
      expect(readdirSync(join(raiz, 'events'))).toHaveLength(2);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('watcher/jsonFileSink: carpetas de rutas ordenadas por fecha', () => {
  const ruta = (nombre: string, fechaCreacion: string) => ({
    numeroRuta: nombre,
    consultaOriginal: nombre,
    almacen: 'SAGUNTO',
    motivos: ['decaGenerada' as const],
    consulta: { filtroLog: nombre, metodoResolucion: 'id-ruta' as const, llamadas: [] },
    consultadoEn: '2026-10-06T08:00:00Z',
    deca: [{ shipmentReference: `${nombre}-AZA`, estado: 'ENVIADO', fechaCreacion } as never],
    envios: [],
    descargas: [],
  });

  it('el orden ALFABETICO de las carpetas coincide con el de creacion del DECA, no con el nombre de la ruta', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      // Por nombre irian RT0001, RT0002, RT0003; por fecha de creacion: RT0003, RT0001, RT0002.
      await sink.onRutaDecaActualizada?.(ruta('RT0001_2026_X', '05/10/2026 12:00:00'));
      await sink.onRutaDecaActualizada?.(ruta('RT0002_2026_X', '05/10/2026 15:30:10'));
      await sink.onRutaDecaActualizada?.(ruta('RT0003_2026_X', '05/10/2026 08:15:00'));

      expect(readdirSync(raiz).filter((n) => n !== 'events').sort()).toEqual([
        '2026-10-05T08-15-00--RT0003_2026_X',
        '2026-10-05T12-00-00--RT0001_2026_X',
        '2026-10-05T15-30-10--RT0002_2026_X',
      ]);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('una nueva actualizacion de la misma ruta reutiliza SU carpeta (no crea otra ni la renombra)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'watcher-json-'));
    try {
      const sink = createJsonFileSink(join(raiz, 'events'), createLogger('error'), undefined, raiz);
      await sink.onRutaDecaActualizada?.(ruta('RT0001_2026_X', '05/10/2026 12:00:00'));
      await sink.onRutaDecaActualizada?.({ ...ruta('RT0001_2026_X', '05/10/2026 12:00:00'), consultadoEn: '2026-10-06T09:00:00Z' });
      expect(readdirSync(raiz).filter((n) => n !== 'events')).toEqual(['2026-10-05T12-00-00--RT0001_2026_X']);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
