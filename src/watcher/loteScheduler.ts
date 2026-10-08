/**
 * Ejecuta las tareas por LOTES: toma hasta `tamano` tareas, las lanza juntas, ESPERA a que terminen todas
 * (la confirmacion) y, si quedan mas en cola, descansa `pausaMs` antes de lanzar el siguiente lote.
 *
 * Se usa para no saturar LUX al arrancar el watcher: el backlog de eventos y el repaso de rutas no salen
 * todos a la vez, sino de 5 en 5, y cada lote empieza cuando el anterior ya acabo. Con poca actividad no
 * aporta retraso: una tarea que llega con la cola vacia empieza al instante (la pausa solo separa lotes
 * consecutivos).
 */
export class LoteScheduler {
  private readonly cola: Array<{ tarea: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  private activo = false;

  constructor(
    private readonly tamano: number,
    private readonly pausaMs: number,
    private readonly esperar: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (!Number.isInteger(tamano) || tamano < 1) {
      throw new Error('LoteScheduler: el tamano del lote debe ser un entero >= 1');
    }
  }

  /** Tareas esperando su lote. */
  get pendientes(): number {
    return this.cola.length;
  }

  run<T>(tarea: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.cola.push({ tarea, resolve: resolve as (v: unknown) => void, reject });
      void this.bombear();
    });
  }

  private async bombear(): Promise<void> {
    if (this.activo) {
      return;
    }
    this.activo = true;
    try {
      // Cede un instante para que las tareas encoladas en este mismo tick entren en el MISMO lote.
      await Promise.resolve();
      while (this.cola.length > 0) {
        const lote = this.cola.splice(0, this.tamano);
        await Promise.all(
          lote.map(async (item) => {
            try {
              item.resolve(await item.tarea());
            } catch (err) {
              item.reject(err);
            }
          }),
        );
        if (this.cola.length > 0 && this.pausaMs > 0) {
          await this.esperar(this.pausaMs);
        }
      }
    } finally {
      this.activo = false;
    }
  }
}
