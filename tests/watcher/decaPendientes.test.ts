import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buscarDecaPendientes, firmaDeca } from '../../src/watcher/decaPendientes';

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
    carpeta('c', [{ estado: 'FIRMADO', shipmentStatus: 'delivered', shipmentId: 'S2' }], { pdf: true });

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
    writeFileSync(join(dir, '2026-10-05T10-05-00-000--rutadeca-X.json'), JSON.stringify({ numeroRuta: 'R', deca: [{ estado: 'FIRMADO', shipmentStatus: 'delivered', shipmentId: 'S1' }] }));
    writeFileSync(join(dir, 'Porte.pdf'), 'PDF');
    expect(await buscarDecaPendientes(raiz, true)).toEqual([]);
  });

  describe('seguimiento de DECA completos hasta que el envio este entregado', () => {
    const ahora = new Date(2026, 9, 7, 13, 0, 0).getTime();
    const fila = (shipmentStatus: string, estado = 'FIRMADO', fechaCreacion = '07/10/2026 12:00:00') => ({ estado, shipmentStatus, documentStatus: 'pending', shipmentId: 'S1', fechaCreacion, fechaEnvio: '07/10/2026 12:01:00' });

    it('un DECA completo (shipmentId + PDF) que NO esta entregado queda en seguimiento, con la firma de su estado', async () => {
      carpeta('a', [fila('created', 'ENVIADO')], { pdf: true });
      carpeta('b', [fila('pending_delivery')], { pdf: true });
      const r = await buscarDecaPendientes(raiz, true, { ahora });
      expect(r.map((p) => [p.carpeta, p.motivo])).toEqual([['a', 'seguimiento'], ['b', 'seguimiento']]);
      expect(r[1]?.firma).toBe(firmaDeca([fila('pending_delivery')]));
      expect(firmaDeca([fila('ready_for_pickup')])).not.toBe(firmaDeca([fila('pending_delivery')])); // un cambio de estado cambia la firma
    });

    it('deja de seguirse al ENTREGARSE (delivered), si es antiguo o sin Docuten', async () => {
      carpeta('entregado', [fila('delivered')], { pdf: true });
      carpeta('viejo', [fila('created', 'ENVIADO', '01/09/2026 12:00:00')], { pdf: true });
      carpeta('reciente', [fila('created', 'ENVIADO')], { pdf: true });
      expect((await buscarDecaPendientes(raiz, true, { ahora })).map((p) => p.carpeta)).toEqual(['reciente']);
      expect(await buscarDecaPendientes(raiz, false, { ahora })).toEqual([]); // sin Docuten no hay PDF que actualizar
      expect((await buscarDecaPendientes(raiz, true, { ahora, seguimientoDias: 60 })).map((p) => p.carpeta)).toEqual(['reciente', 'viejo']);
    });

    it('un DECA incompleto sigue siendo incompleto (no seguimiento)', async () => {
      carpeta('a', [{ estado: 'PENDIENTE ENVIO', shipmentId: '' }]);
      expect((await buscarDecaPendientes(raiz, true, { ahora })).map((p) => p.motivo)).toEqual(['sin-shipmentId']);
    });
  });

  it('una carpeta raiz que no existe no da error', async () => {
    expect(await buscarDecaPendientes(join(raiz, 'no-existe'), true)).toEqual([]);
  });
});
