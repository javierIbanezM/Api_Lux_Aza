import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buscarCarpetaDeRuta, migrarCarpetas, nombreCarpetaRuta, parseFechaLux, prefijoFecha } from '../../src/watcher/carpetasDeca';

describe('watcher/carpetasDeca', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'carpetas-deca-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parseFechaLux lee el formato de LUX (dd/MM/yyyy HH:mm:ss) en hora local', () => {
    expect(parseFechaLux('05/10/2026 17:25:02')).toBe(new Date(2026, 9, 5, 17, 25, 2).getTime());
    expect(parseFechaLux('05/10/2026')).toBe(new Date(2026, 9, 5, 0, 0, 0).getTime());
    expect(parseFechaLux('')).toBeUndefined();
    expect(parseFechaLux(undefined)).toBeUndefined();
  });

  it('prefijoFecha usa la creacion MAS ANTIGUA de los envios; sin fechas, el respaldo', () => {
    expect(prefijoFecha(['05/10/2026 17:25:02', '05/10/2026 08:01:36', undefined], 0)).toBe('2026-10-05T08-01-36');
    expect(prefijoFecha([undefined, ''], new Date(2026, 9, 6, 9, 0, 5).getTime())).toBe('2026-10-06T09-00-05');
    expect(nombreCarpetaRuta('2026-10-05T08-01-36', 'RT1')).toBe('2026-10-05T08-01-36--RT1');
  });

  it('buscarCarpetaDeRuta encuentra la carpeta con fecha o la antigua sin fecha', async () => {
    mkdirSync(join(dir, '2026-10-05T08-01-36--RT1_2026_X'));
    mkdirSync(join(dir, 'RT2_2026_X'));
    expect(await buscarCarpetaDeRuta(dir, 'RT1_2026_X')).toBe('2026-10-05T08-01-36--RT1_2026_X');
    expect(await buscarCarpetaDeRuta(dir, 'RT2_2026_X')).toBe('RT2_2026_X');
    expect(await buscarCarpetaDeRuta(dir, 'RT3_2026_X')).toBeUndefined();
    expect(await buscarCarpetaDeRuta(join(dir, 'no-existe'), 'RT1')).toBeUndefined();
  });

  it('migrarCarpetas salta una carpeta cuyo destino ya existe y migra las demas, sin lanzar', async () => {
    mkdirSync(join(dir, 'RT1_2026_X'));
    mkdirSync(join(dir, 'RT2_2026_X'));
    writeFileSync(join(dir, 'RT1_2026_X', 'a--rutadeca-RT1.json'), JSON.stringify({ deca: [{ fechaCreacion: '05/10/2026 07:00:00' }] }));
    writeFileSync(join(dir, 'RT2_2026_X', 'b--rutadeca-RT2.json'), JSON.stringify({ deca: [{ fechaCreacion: '05/10/2026 08:00:00' }] }));
    // El nombre de destino de RT1 ya esta ocupado: esa carpeta se deja como estaba.
    writeFileSync(join(dir, '2026-10-05T07-00-00--RT1_2026_X'), 'ocupado');

    expect(await migrarCarpetas(dir)).toBe(1);
    expect(readdirSync(dir)).toContain('2026-10-05T08-00-00--RT2_2026_X');
    expect(readdirSync(dir)).toContain('RT1_2026_X');
  });

  it('migrarCarpetas pone la fecha delante de las carpetas antiguas (creacion del DECA, o consultadoEn si no hay) y no toca las que ya la tienen', async () => {
    mkdirSync(join(dir, 'RT1_2026_X'));
    writeFileSync(join(dir, 'RT1_2026_X', 'a--rutadeca-RT1.json'), JSON.stringify({ deca: [{ fechaCreacion: '05/10/2026 07:31:15' }, { fechaCreacion: '05/10/2026 08:01:36' }], consultadoEn: '2026-10-06T00:00:00Z' }));
    writeFileSync(join(dir, 'RT1_2026_X', 'Porte.pdf'), 'PDF');
    mkdirSync(join(dir, 'RT2_2026_X')); // sin fecha de creacion del DECA: usa consultadoEn
    writeFileSync(join(dir, 'RT2_2026_X', 'b--rutadeca-RT2.json'), JSON.stringify({ deca: [], consultadoEn: '2026-10-05T10:00:00.000Z' }));
    mkdirSync(join(dir, '2026-10-01T00-00-00--RT3_2026_X')); // ya migrada

    expect(await migrarCarpetas(dir)).toBe(2);
    const nombres = readdirSync(dir).sort();
    expect(nombres).toContain('2026-10-05T07-31-15--RT1_2026_X');
    expect(nombres).toContain('2026-10-01T00-00-00--RT3_2026_X');
    expect(nombres.some((n) => n.endsWith('--RT2_2026_X'))).toBe(true);
    expect(nombres).not.toContain('RT1_2026_X');
    expect(readdirSync(join(dir, '2026-10-05T07-31-15--RT1_2026_X'))).toContain('Porte.pdf'); // el contenido se conserva

    expect(await migrarCarpetas(dir)).toBe(0); // idempotente
  });
});
