import { describe, expect, it } from 'vitest';
import { LoteScheduler } from '../../src/watcher/loteScheduler';

const esperar = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('watcher/LoteScheduler', () => {
  it('lanza las tareas de 5 en 5: el lote siguiente NO empieza hasta que terminan TODAS las del anterior (y tras la pausa)', async () => {
    const eventos: string[] = [];
    const pausas: number[] = [];
    const scheduler = new LoteScheduler(5, 1000, async (ms) => {
      pausas.push(ms);
      eventos.push('pausa');
    });
    const tarea = (n: number) =>
      scheduler.run(async () => {
        eventos.push(`inicio ${n}`);
        await esperar(n === 0 ? 40 : 5); // la tarea 0 es la lenta: el lote espera por ella
        eventos.push(`fin ${n}`);
        return n;
      });

    const resultados = await Promise.all(Array.from({ length: 12 }, (_, i) => tarea(i)));

    expect(resultados).toEqual(Array.from({ length: 12 }, (_, i) => i));
    // lote 1 = tareas 0-4 (juntas), lote 2 = 5-9, lote 3 = 10-11
    expect(eventos.slice(0, 5)).toEqual(['inicio 0', 'inicio 1', 'inicio 2', 'inicio 3', 'inicio 4']);
    const inicio5 = eventos.indexOf('inicio 5');
    for (const n of [0, 1, 2, 3, 4]) {
      expect(eventos.indexOf(`fin ${n}`)).toBeLessThan(inicio5); // ningun lote 2 antes de acabar el 1
    }
    expect(eventos[inicio5 - 1]).toBe('pausa'); // y con la pausa entre medias
    expect(eventos.indexOf('inicio 10')).toBeGreaterThan(eventos.indexOf('fin 9'));
    expect(pausas).toEqual([1000, 1000]); // 2 pausas para 3 lotes; sin pausa al final
  });

  it('con la cola vacia una tarea empieza AL INSTANTE (sin retraso en el funcionamiento normal)', async () => {
    const scheduler = new LoteScheduler(5, 10_000);
    const t0 = Date.now();
    await scheduler.run(async () => 'a');
    await esperar(20); // la cola se vacio: no hay lote consecutivo que separar
    await scheduler.run(async () => 'b');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('una tarea que falla no bloquea a las demas del lote ni a los lotes siguientes', async () => {
    const scheduler = new LoteScheduler(2, 0);
    const r = await Promise.allSettled([
      scheduler.run(async () => {
        throw new Error('boom');
      }),
      scheduler.run(async () => 'b'),
      scheduler.run(async () => 'c'),
    ]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(scheduler.pendientes).toBe(0);
  });

  it('tareas que llegan mientras corre un lote entran en el siguiente', async () => {
    const orden: string[] = [];
    const scheduler = new LoteScheduler(2, 0);
    const a = scheduler.run(async () => {
      orden.push('a');
      await esperar(20);
    });
    const b = scheduler.run(async () => orden.push('b'));
    await esperar(5);
    const c = scheduler.run(async () => orden.push('c')); // llega con el lote 1 en marcha
    await Promise.all([a, b, c]);
    expect(orden).toEqual(['a', 'b', 'c']);
  });

  it('rechaza un tamano de lote invalido', () => {
    expect(() => new LoteScheduler(0, 0)).toThrow();
  });
});
