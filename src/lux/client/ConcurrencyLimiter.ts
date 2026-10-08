/**
 * Limita cuantas operaciones asincronas se ejecutan a la vez; el resto espera su turno (FIFO).
 *
 * Se usa para no saturar LUX: al arrancar, el watcher tiene mucho pendiente (eventos acumulados,
 * repaso de DECA, totales de rutas) y, sin limite, lanza decenas de llamadas simultaneas. LUX tarda
 * mas de `LUX_TIMEOUT_MS` en responder, nuestro cliente abandona la conexion y LUX deja un SEVERE en
 * su log por cada una; ademas, todo el que usa LUX (los usuarios de la oficina) va mas lento.
 */
export class ConcurrencyLimiter {
  private activas = 0;
  private readonly cola: Array<() => void> = [];

  constructor(private readonly maximo: number) {
    if (!Number.isInteger(maximo) || maximo < 1) {
      throw new Error('ConcurrencyLimiter: el maximo debe ser un entero >= 1');
    }
  }

  /** Operaciones en curso. */
  get enCurso(): number {
    return this.activas;
  }

  /** Operaciones esperando turno. */
  get esperando(): number {
    return this.cola.length;
  }

  async run<T>(tarea: () => Promise<T>): Promise<T> {
    if (this.activas >= this.maximo) {
      await new Promise<void>((resolve) => this.cola.push(resolve));
    } else {
      this.activas += 1;
    }
    try {
      return await tarea();
    } finally {
      const siguiente = this.cola.shift();
      if (siguiente) {
        siguiente(); // el turno pasa directamente al siguiente: `activas` no cambia
      } else {
        this.activas -= 1;
      }
    }
  }
}
