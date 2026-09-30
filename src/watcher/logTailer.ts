import { open, stat } from 'node:fs/promises';

/**
 * Sigue un fichero de log por sondeo periodico (no `fs.watch`): los logs de LUX viven en una
 * unidad de red (`S:\TLSI\...`), donde los eventos nativos de cambio de fichero no son fiables.
 * Reabre el fichero en cada sondeo (en vez de mantener un descriptor abierto todo el rato) para
 * tolerar mejor cortes de conectividad de red.
 *
 * Al arrancar, se posiciona al FINAL del fichero (no reprocesa el historico completo, que puede
 * tener meses de antiguedad). Detecta rotacion/truncado del fichero (tamano actual menor que la
 * ultima posicion leida) y se reposiciona al principio del fichero nuevo.
 */
export class LogTailer {
  private position = 0;
  private partialLine = '';
  private initialized = false;

  constructor(
    private readonly filePath: string,
    private readonly onLines: (lines: string[]) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Sondea el fichero una vez. Pensado para llamarse en un `setInterval` externo. */
  async poll(): Promise<void> {
    try {
      const stats = await stat(this.filePath);

      if (!this.initialized) {
        // Primera vez: nos situamos al final, no reprocesamos el historico.
        this.position = stats.size;
        this.initialized = true;
        return;
      }

      if (stats.size < this.position) {
        // El fichero se ha rotado/truncado (p.ej. lux.log.0 se renombro a lux.log.0.1 y empezo
        // uno nuevo mas pequeno, o se recorto). Empezamos de nuevo desde el principio del
        // fichero actual para no perder lineas nuevas.
        this.position = 0;
        this.partialLine = '';
      }

      if (stats.size === this.position) {
        return; // sin novedades
      }

      const handle = await open(this.filePath, 'r');
      try {
        const length = stats.size - this.position;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.position);
        this.position = stats.size;

        const chunk = this.partialLine + buffer.toString('utf-8');
        const lines = chunk.split(/\r?\n/);
        // La ultima "linea" puede estar incompleta si el escritor aun no ha terminado de
        // escribirla en este instante; se guarda para completarla en el siguiente sondeo.
        this.partialLine = lines.pop() ?? '';

        const nonEmpty = lines.filter((line) => line.length > 0);
        if (nonEmpty.length > 0) {
          this.onLines(nonEmpty);
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      this.onError(err);
    }
  }
}
