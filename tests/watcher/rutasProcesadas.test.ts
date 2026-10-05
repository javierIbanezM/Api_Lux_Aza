import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RutasProcesadas, claveRuta, leerMarcasDeCarpetas } from '../../src/watcher/rutasProcesadas';

describe('watcher/rutasProcesadas', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rutas-procesadas-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('claveRuta ignora comodines, espacios y mayusculas (misma ruta -> misma clave)', () => {
    expect(claveRuta('SAGUNTO', '%RT00013615_2026_COMP %')).toBe(claveRuta('SAGUNTO', 'rt00013615_2026_comp'));
    expect(claveRuta('SAGUNTO', 'RT1')).not.toBe(claveRuta('CHESTE', 'RT1'));
  });

  it('yaProcesada: true si la marca cubre el evento (con tolerancia de reloj), false si el evento es posterior', () => {
    const r = new RutasProcesadas(join(dir, 'r.json'), 60_000);
    r.marcar('k', 1_000_000);
    expect(r.yaProcesada('k', 1_000_000)).toBe(true);
    expect(r.yaProcesada('k', 1_050_000)).toBe(true); // dentro de la tolerancia (reloj de LUX vs el de este equipo)
    expect(r.yaProcesada('k', 1_100_000)).toBe(false); // consulta claramente posterior: hay que procesarla
    expect(r.yaProcesada('otra', 1)).toBe(false);
  });

  it('marcar conserva la marca mas reciente', () => {
    const r = new RutasProcesadas(join(dir, 'r.json'), 0);
    r.marcar('k', 500);
    r.marcar('k', 100);
    expect(r.yaProcesada('k', 500)).toBe(true);
    expect(r.yaProcesada('k', 501)).toBe(false);
  });

  it('guarda y recarga el registro desde disco', async () => {
    const f = join(dir, 'estado', 'r.json');
    const a = new RutasProcesadas(f, 0);
    await a.cargar(join(dir, 'no-existe'));
    a.marcar('ruta:SAGUNTO:RT1', 777);
    await a.guardar();
    const b = new RutasProcesadas(f, 0);
    expect(await b.cargar(join(dir, 'no-existe'))).toBe(1);
    expect(b.yaProcesada('ruta:SAGUNTO:RT1', 777)).toBe(true);
  });

  it('la primera vez se inicializa con los JSON de ruta que ya hay en disco (no se rehace lo ya hecho)', async () => {
    const rutas = join(dir, 'rutas-deca');
    mkdirSync(join(rutas, 'RT00013533_2026_SUSMEDIOS'), { recursive: true });
    const consultadoEn = '2026-10-05T10:44:06.000Z';
    writeFileSync(
      join(rutas, 'RT00013533_2026_SUSMEDIOS', '2026-10-05T12-44-06-732--rutadeca-RT00013533_2026_SUSMEDIOS.json'),
      JSON.stringify({ consultaOriginal: '%RT00013533_2026_SUSMEDIOS%', almacen: 'SAGUNTO', consultadoEn }),
    );
    writeFileSync(join(rutas, 'suelto-estructura-antigua.json'), '{}'); // fichero suelto: se ignora

    expect(await leerMarcasDeCarpetas(rutas)).toEqual([{ clave: 'ruta:SAGUNTO:RT00013533_2026_SUSMEDIOS', t: Date.parse(consultadoEn) }]);

    const r = new RutasProcesadas(join(dir, 'estado', 'r.json'));
    await r.cargar(rutas);
    expect(r.yaProcesada('ruta:SAGUNTO:RT00013533_2026_SUSMEDIOS', Date.parse(consultadoEn) - 5_000)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'estado', 'r.json'), 'utf-8')).rutas).toBeDefined(); // ya persistido
  });
});
