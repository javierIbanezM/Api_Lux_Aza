import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogTailer } from '../../src/watcher/logTailer';

describe('watcher/LogTailer', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-log-tailer-'));
    filePath = join(dir, 'lux.log.0');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no emite nada en el primer sondeo si el fichero ya tenia contenido (no reprocesa el historico)', async () => {
    writeFileSync(filePath, 'linea vieja 1\nlinea vieja 2\n');
    const received: string[] = [];
    const tailer = new LogTailer(filePath, (lines) => received.push(...lines), () => {});

    await tailer.poll(); // primer sondeo: se posiciona al final, no emite nada

    expect(received).toEqual([]);
  });

  it('emite las lineas nuevas añadidas despues del primer sondeo', async () => {
    writeFileSync(filePath, 'linea vieja\n');
    const received: string[] = [];
    const tailer = new LogTailer(filePath, (lines) => received.push(...lines), () => {});

    await tailer.poll(); // baseline
    appendFileSync(filePath, 'linea nueva 1\nlinea nueva 2\n');
    await tailer.poll();

    expect(received).toEqual(['linea nueva 1', 'linea nueva 2']);
  });

  it('completa una linea que estaba a medio escribir en el sondeo anterior', async () => {
    writeFileSync(filePath, '');
    const received: string[] = [];
    const tailer = new LogTailer(filePath, (lines) => received.push(...lines), () => {});

    await tailer.poll(); // baseline (fichero vacio)
    appendFileSync(filePath, 'linea a medi'); // sin salto de linea todavia
    await tailer.poll();
    expect(received).toEqual([]); // no hay salto de linea, se guarda como parcial

    appendFileSync(filePath, 'as\nsegunda linea completa\n');
    await tailer.poll();
    expect(received).toEqual(['linea a medias', 'segunda linea completa']);
  });

  it('detecta la rotacion del fichero (tamano menor que la ultima posicion leida) y sigue leyendo', async () => {
    writeFileSync(filePath, 'linea original\n');
    const received: string[] = [];
    const tailer = new LogTailer(filePath, (lines) => received.push(...lines), () => {});

    await tailer.poll(); // baseline
    appendFileSync(filePath, 'linea antes de rotar\n');
    await tailer.poll();
    expect(received).toEqual(['linea antes de rotar']);

    // Simula rotacion: el fichero se trunca/renombra y empieza uno nuevo mas pequeno.
    writeFileSync(filePath, 'primera linea del fichero rotado\n');
    await tailer.poll();

    expect(received).toEqual(['linea antes de rotar', 'primera linea del fichero rotado']);
  });

  it('llama a onError si el fichero no existe, sin lanzar', async () => {
    const errors: unknown[] = [];
    const tailer = new LogTailer(join(dir, 'no-existe.log'), () => {}, (err) => errors.push(err));

    await expect(tailer.poll()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
