import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buscarDecaPendientes } from '../../src/watcher/decaPendientes';

describe('watcher/decaPendientes', () => {
  let raiz: string;
  beforeEach(() => {
    raiz = mkdtempSync(join(tmpdir(), 'deca-pend-'));
  });
  afterEach(() => rmSync(raiz, { recursive: true, force: true }));

  const carpeta = (nombre: string, deca: unknown[], extra: { pdf?: boolean; json?: string[] } = {}): void => {
    const dir = join(raiz, nombre);
    mkdirSync(dir);
    // el ULTIMO json (por nombre) es el que cuenta
    for (const j of extra.json ?? ['2026-10-05T10-00-00-000--rutadeca-X.json']) {
      writeFileSync(join(dir, j), JSON.stringify({ numeroRuta: `RUTA-${nombre}`, almacen: 'SAGUNTO', deca }));
    }
    if (extra.pdf) {
      writeFileSync(join(dir, 'Porte.pdf'), 'PDF');
    }
  };

  it('detecta envios sin shipmentId y envios con shipmentId pero sin PDF (si hay Docuten)', async () => {
    carpeta('a', [{ estado: 'PENDIENTE ENVIO', shipmentId: '' }]);
    carpeta('b', [{ estado: 'ENVIADO', shipmentId: 'S1' }]);
    carpeta('c', [{ estado: 'ENVIADO', shipmentId: 'S2' }], { pdf: true });

    const r = await buscarDecaPendientes(raiz, true);

    expect(r.map((p) => [p.carpeta, p.motivo, p.numeroRuta, p.almacen])).toEqual([
      ['a', 'sin-shipmentId', 'RUTA-a', 'SAGUNTO'],
      ['b', 'sin-pdf', 'RUTA-b', 'SAGUNTO'],
    ]);
  });

  it('sin cliente de Docuten, la falta de PDF no es un pendiente (solo el envio sin shipmentId)', async () => {
    carpeta('a', [{ estado: 'PENDIENTE ENVIO', shipmentId: '' }]);
    carpeta('b', [{ estado: 'ENVIADO', shipmentId: 'S1' }]);
    expect((await buscarDecaPendientes(raiz, false)).map((p) => p.carpeta)).toEqual(['a']);
  });

  it('ignora los envios fallidos (ERROR / ANULADO) y las carpetas sin JSON o con JSON ilegible', async () => {
    carpeta('err', [{ estado: 'ERROR', shipmentId: '' }, { estado: 'ANULADO', shipmentId: '' }]);
    mkdirSync(join(raiz, 'vacia'));
    mkdirSync(join(raiz, 'rota'));
    writeFileSync(join(raiz, 'rota', 'x--rutadeca.json'), '{no es json');
    carpeta('mezcla', [{ estado: 'ANULADO', shipmentId: '' }, { estado: 'PENDIENTE ENVIO', shipmentId: '' }]);
    expect((await buscarDecaPendientes(raiz, true)).map((p) => p.carpeta)).toEqual(['mezcla']);
  });

  it('usa el JSON MAS RECIENTE de la carpeta: si ya esta completo, no es pendiente', async () => {
    const dir = join(raiz, 'r');
    mkdirSync(dir);
    writeFileSync(join(dir, '2026-10-05T10-00-00-000--rutadeca-X.json'), JSON.stringify({ numeroRuta: 'R', deca: [{ estado: 'PENDIENTE ENVIO', shipmentId: '' }] }));
    writeFileSync(join(dir, '2026-10-05T10-05-00-000--rutadeca-X.json'), JSON.stringify({ numeroRuta: 'R', deca: [{ estado: 'ENVIADO', shipmentId: 'S1' }] }));
    writeFileSync(join(dir, 'Porte.pdf'), 'PDF');
    expect(await buscarDecaPendientes(raiz, true)).toEqual([]);
  });

  it('una carpeta raiz que no existe no da error', async () => {
    expect(await buscarDecaPendientes(join(raiz, 'no-existe'), true)).toEqual([]);
  });
});
