import { describe, expect, it } from 'vitest';
import { buildSortLinks, normalizeSortDirection, sortRows } from '../../src/web/sorting';

describe('web/sorting', () => {
  it('normalizeSortDirection solo acepta "desc" explicito, cualquier otra cosa es "asc"', () => {
    expect(normalizeSortDirection('desc')).toBe('desc');
    expect(normalizeSortDirection('asc')).toBe('asc');
    expect(normalizeSortDirection(undefined)).toBe('asc');
    expect(normalizeSortDirection('cualquier-otra-cosa')).toBe('asc');
  });

  it('sortRows sin field no reordena', () => {
    const rows = [{ estado: 'B' }, { estado: 'A' }];
    expect(sortRows(rows, undefined, 'asc')).toEqual(rows);
  });

  it('sortRows ordena alfabeticamente asc/desc', () => {
    const rows = [{ estado: 'CREACION' }, { estado: 'ENVIADO' }, { estado: 'ANULADO' }];
    expect(sortRows(rows, 'estado', 'asc').map((r) => r.estado)).toEqual(['ANULADO', 'CREACION', 'ENVIADO']);
    expect(sortRows(rows, 'estado', 'desc').map((r) => r.estado)).toEqual(['ENVIADO', 'CREACION', 'ANULADO']);
  });

  it('sortRows ordena fechas dd/MM/yyyy cronologicamente, no alfabeticamente', () => {
    // Alfabeticamente "05/12/2026" iria antes que "20/01/2026" (el "0" de 05 < "2" de 20), pero
    // cronologicamente enero es antes que diciembre: confirma que se compara como fecha real.
    const rows = [{ fecha: '05/12/2026' }, { fecha: '20/01/2026' }, { fecha: '' }];
    expect(sortRows(rows, 'fecha', 'asc').map((r) => r.fecha)).toEqual(['', '20/01/2026', '05/12/2026']);
  });

  it('sortRows tolera fechas con hora (formato real de LUX) y no revienta con formatos raros', () => {
    const rows = [{ fecha: '27/04/2026 13:20:13' }, { fecha: '25/04/2026 08:13:51' }];
    expect(sortRows(rows, 'fecha', 'asc').map((r) => r.fecha)).toEqual([
      '25/04/2026 08:13:51',
      '27/04/2026 13:20:13',
    ]);
  });

  it('sortRows no muta el array original', () => {
    const rows = [{ estado: 'B' }, { estado: 'A' }];
    const original = [...rows];
    sortRows(rows, 'estado', 'asc');
    expect(rows).toEqual(original);
  });

  it('buildSortLinks alterna asc->desc si ya se ordenaba por la misma columna', () => {
    const links = buildSortLinks('/almacen/expediciones', { propietario: 'AZA' }, ['estado'], 'estado', 'asc');
    expect(links.estado!.href).toBe('/almacen/expediciones?propietario=AZA&sort=estado&dir=desc');
    expect(links.estado!.indicator).toBe('▲');
  });

  it('buildSortLinks empieza en asc para una columna distinta a la actual', () => {
    const links = buildSortLinks('/almacen/expediciones', {}, ['tipo'], 'estado', 'desc');
    expect(links.tipo!.href).toBe('/almacen/expediciones?sort=tipo&dir=asc');
    expect(links.tipo!.indicator).toBe('');
  });
});
