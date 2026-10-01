import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
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

describe('watcher/LogTailer con estado persistente (corte y rotacion)', () => {
  let dir: string;
  let log0: string;
  let log1: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-log-tailer-state-'));
    log0 = join(dir, 'lux.log.0');
    log1 = join(dir, 'lux.log.1');
    statePath = join(dir, 'state', 'lux.state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (received: string[]) => new LogTailer(log0, (l) => received.push(...l), () => {}, statePath);

  it('tras un reinicio sin rotacion, recupera lo escrito durante el corte', async () => {
    writeFileSync(log0, 'cabecera\nvieja\n');
    const first: string[] = [];
    await make(first).poll(); // baseline + guarda estado
    appendFileSync(log0, 'durante el corte\n');

    const second: string[] = [];
    const restarted = make(second);
    await restarted.poll();
    expect(second).toEqual(['durante el corte']);

    appendFileSync(log0, 'nueva\n');
    await restarted.poll();
    expect(second).toEqual(['durante el corte', 'nueva']);
  });

  it('tras un reinicio con rotacion, lee el resto de lux.log.1 y despues lux.log.0', async () => {
    writeFileSync(log0, 'cabecera A\nvieja\n');
    await make([]).poll();
    // Durante el corte: se escribe mas en A y rota (A pasa a lux.log.1, empieza B).
    appendFileSync(log0, 'resto de A\n');
    renameSync(log0, log1);
    writeFileSync(log0, 'cabecera B\nprimera de B\n');

    const received: string[] = [];
    await make(received).poll();

    expect(received).toEqual(['resto de A', 'cabecera B', 'primera de B']);
  });

  it('detecta la rotacion con el servicio en marcha sin perder el final del fichero viejo', async () => {
    writeFileSync(log0, 'cabecera A\n');
    const received: string[] = [];
    const tailer = make(received);
    await tailer.poll();
    appendFileSync(log0, 'ultima de A\n');
    renameSync(log0, log1);
    writeFileSync(log0, 'cabecera B\nprimera de B\n');
    await tailer.poll();

    expect(received).toEqual(['ultima de A', 'cabecera B', 'primera de B']);
  });

  it('avisa y lee lux.log.0 entero si no encuentra el fichero previo en lux.log.1', async () => {
    writeFileSync(log0, 'cabecera A\n');
    await make([]).poll();
    writeFileSync(log0, 'cabecera C\nlinea C\n'); // dos rotaciones: A ya no esta en .1

    const received: string[] = [];
    const errors: unknown[] = [];
    await new LogTailer(log0, (l) => received.push(...l), (e) => errors.push(e), statePath).poll();

    expect(received).toEqual(['cabecera C', 'linea C']);
    expect(errors).toHaveLength(1);
  });

  it('una linea parcial pendiente al cortarse se completa tras el reinicio', async () => {
    writeFileSync(log0, 'cabecera\n');
    const t = make([]);
    await t.poll();
    appendFileSync(log0, 'linea a medi');
    await t.poll();
    appendFileSync(log0, 'as\n');

    const received: string[] = [];
    await make(received).poll();
    expect(received).toEqual(['linea a medias']);
  });
});

describe('watcher/LogTailer caracteres multibyte', () => {
  it('no corrompe un caracter UTF-8 partido entre dos lecturas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-log-tailer-utf8-'));
    const file = join(dir, 'lux.log.0');
    try {
      writeFileSync(file, 'cabecera\n');
      const received: string[] = [];
      const tailer = new LogTailer(file, (l) => received.push(...l), () => {});
      await tailer.poll(); // baseline

      const bytes = Buffer.from('almacén central\n', 'utf-8');
      const corte = bytes.indexOf(0xc3) + 1; // mitad de la "é" (2 bytes)
      appendFileSync(file, bytes.subarray(0, corte));
      await tailer.poll();
      appendFileSync(file, bytes.subarray(corte));
      await tailer.poll();

      expect(received).toEqual(['almacén central']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
