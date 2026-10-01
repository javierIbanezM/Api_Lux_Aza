import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Bytes del principio del fichero que se leen para sacar su "huella" (primera linea). */
const FINGERPRINT_BYTES = 256;

interface TailerState {
  /** Bytes ya procesados del fichero identificado por `fingerprint`. */
  position: number;
  /** Primera linea del fichero (lleva fecha y hora, no se repite entre ficheros). */
  fingerprint: string | undefined;
}

/**
 * Sigue un fichero de log por sondeo periodico (no `fs.watch`): los logs de LUX viven en una
 * unidad de red (`S:\TLSI\...`), donde los eventos nativos de cambio de fichero no son fiables.
 * Reabre el fichero en cada sondeo (en vez de mantener un descriptor abierto todo el rato) para
 * tolerar mejor cortes de conectividad de red.
 *
 * LUX rota el log al llegar a 10 MB: `lux.log.0` pasa a `lux.log.1` y empieza un `lux.log.0`
 * nuevo. Solo se consideran esos dos ficheros (`lux.log.0` y `lux.log.1`). Para no perder
 * eventos si el servicio se corta y/o el fichero rota mientras tanto, se recuerda la posicion
 * leida y la huella (primera linea) del fichero al que corresponde:
 *  - misma huella en `lux.log.0`: se sigue leyendo desde la posicion guardada;
 *  - huella distinta: hubo rotacion. Si `lux.log.1` tiene la huella guardada, se lee lo que
 *    faltaba de `lux.log.1` y despues `lux.log.0` entero; si no (rotaciones multiples), se lee
 *    `lux.log.0` entero y se avisa via `onError`.
 *
 * Con `statePath` el estado se persiste en disco y sobrevive a reinicios. Si no hay estado
 * previo (primera ejecucion, o sin `statePath`) se posiciona al FINAL del fichero actual, sin
 * reprocesar el historico.
 */
export class LogTailer {
  private state: TailerState | undefined;
  /** Bytes de una linea aun sin terminar (se guardan como bytes, no como texto, para no partir un
   *  caracter UTF-8 multibyte si el corte de lectura cae en mitad de el). */
  private partial: Buffer = Buffer.alloc(0);
  private stateLoaded: boolean;
  private polling = false;
  private readonly rotatedPath: string | undefined;

  constructor(
    private readonly filePath: string,
    private readonly onLines: (lines: string[]) => void,
    private readonly onError: (err: unknown) => void,
    private readonly statePath?: string,
  ) {
    this.stateLoaded = statePath === undefined;
    this.rotatedPath = /\.0$/.test(filePath) ? filePath.replace(/\.0$/, '.1') : undefined;
  }

  /** Sondea el fichero una vez. Pensado para llamarse en un `setInterval` externo. */
  async poll(): Promise<void> {
    if (this.polling) {
      return; // el sondeo anterior sigue en curso (p.ej. unidad de red lenta): no solapar
    }
    this.polling = true;
    try {
      if (!this.stateLoaded) {
        this.state = await this.loadState();
        this.stateLoaded = true;
      }

      const stats = await stat(this.filePath);
      const fingerprint = await this.readFingerprint(this.filePath, stats.size);

      if (!this.state) {
        // Primera vez: nos situamos al final, no reprocesamos el historico.
        this.state = { position: stats.size, fingerprint };
        await this.saveState();
        return;
      }

      const saved = this.state;
      const sameFile = fingerprint === undefined || saved.fingerprint === undefined
        ? stats.size >= saved.position
        : fingerprint === saved.fingerprint;

      let data: Buffer;
      const newPosition = stats.size;

      if (sameFile) {
        if (stats.size < saved.position) {
          // Truncado del propio fichero: empezamos desde el principio.
          saved.position = 0;
          this.partial = Buffer.alloc(0);
        }
        if (stats.size === saved.position) {
          if (saved.fingerprint === undefined && fingerprint !== undefined) {
            saved.fingerprint = fingerprint;
            await this.saveState();
          }
          return; // sin novedades
        }
        data = await this.readRange(this.filePath, saved.position, stats.size);
      } else {
        data = await this.readAfterRotation(saved, stats.size);
      }

      this.state = { position: newPosition, fingerprint };
      this.emit(data);
      await this.saveState();
    } catch (err) {
      this.onError(err);
    } finally {
      this.polling = false;
    }
  }

  /** Rotacion detectada: recupera lo que faltaba de `lux.log.1` (si es el fichero que se estaba
   *  leyendo) y lee `lux.log.0` completo. */
  private async readAfterRotation(saved: TailerState, currentSize: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let foundRotated = false;

    if (this.rotatedPath && saved.fingerprint !== undefined) {
      try {
        const rotatedStats = await stat(this.rotatedPath);
        const rotatedFingerprint = await this.readFingerprint(this.rotatedPath, rotatedStats.size);
        if (rotatedFingerprint === saved.fingerprint && rotatedStats.size >= saved.position) {
          parts.push(await this.readRange(this.rotatedPath, saved.position, rotatedStats.size));
          foundRotated = true;
        }
      } catch {
        // lux.log.1 no existe o no es legible: se trata como "no encontrado".
      }
    }

    if (!foundRotated) {
      this.partial = Buffer.alloc(0);
      this.onError(
        new Error(
          `Rotacion detectada en ${this.filePath} pero no se encontro el fichero previo en lux.log.1; ` +
            'se lee lux.log.0 completo (puede haberse perdido el tramo intermedio)',
        ),
      );
    }

    parts.push(await this.readRange(this.filePath, 0, currentSize));
    return Buffer.concat(parts);
  }

  private emit(data: Buffer): void {
    const all = Buffer.concat([this.partial, data]);
    // Solo se procesa hasta el ultimo salto de linea: lo que queda es una linea que el escritor
    // aun no ha terminado de escribir, se completa en el siguiente sondeo.
    const lastNewline = all.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      this.partial = all;
      return;
    }
    this.partial = all.subarray(lastNewline + 1);

    const lines = all
      .subarray(0, lastNewline + 1)
      .toString('utf-8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    if (lines.length > 0) {
      this.onLines(lines);
    }
  }

  private async readRange(path: string, from: number, to: number): Promise<Buffer> {
    const length = to - from;
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** Primera linea del fichero, o `undefined` si aun no esta completa (fichero vacio/recien creado). */
  private async readFingerprint(path: string, size: number): Promise<string | undefined> {
    if (size === 0) {
      return undefined;
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.toString('utf-8', 0, bytesRead);
      const newline = head.search(/\r?\n/);
      if (newline >= 0) {
        return head.slice(0, newline);
      }
      return bytesRead >= FINGERPRINT_BYTES ? head : undefined;
    } finally {
      await handle.close();
    }
  }

  private async loadState(): Promise<TailerState | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath as string, 'utf-8')) as Partial<TailerState>;
      if (typeof parsed.position === 'number' && parsed.position >= 0) {
        return { position: parsed.position, fingerprint: parsed.fingerprint ?? undefined };
      }
    } catch {
      // Sin estado previo o ilegible: se tratara como primera ejecucion.
    }
    return undefined;
  }

  private async saveState(): Promise<void> {
    if (!this.statePath || !this.state) {
      return;
    }
    await mkdir(dirname(this.statePath), { recursive: true });
    // Se descuenta la linea parcial pendiente para que, tras un reinicio, se vuelva a leer entera.
    const position = Math.max(0, this.state.position - this.partial.length);
    await writeFile(this.statePath, JSON.stringify({ ...this.state, position }), 'utf-8');
  }
}
