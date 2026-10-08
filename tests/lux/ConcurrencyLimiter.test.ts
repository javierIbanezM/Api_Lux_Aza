import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from '../../src/lux/client';

const esperar = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('lux/ConcurrencyLimiter', () => {
  it('nunca ejecuta mas tareas a la vez que el maximo y las atiende por orden', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let activas = 0;
    let maxima = 0;
    const orden: number[] = [];
    const tarea = (n: number) =>
      limiter.run(async () => {
        activas += 1;
        maxima = Math.max(maxima, activas);
        orden.push(n);
        await esperar(15);
        activas -= 1;
        return n * 2;
      });

    const resultados = await Promise.all(Array.from({ length: 12 }, (_, i) => tarea(i)));

    expect(maxima).toBe(3);
    expect(resultados).toEqual(Array.from({ length: 12 }, (_, i) => i * 2));
    expect(orden).toEqual(Array.from({ length: 12 }, (_, i) => i)); // FIFO
    expect(limiter.enCurso).toBe(0);
    expect(limiter.esperando).toBe(0);
  });

  it('una tarea que falla libera su turno y no bloquea a las demas', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const resultados = await Promise.allSettled([
      limiter.run(async () => {
        throw new Error('fallo');
      }),
      limiter.run(async () => 'ok'),
      limiter.run(async () => 'ok2'),
    ]);
    expect(resultados.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(limiter.enCurso).toBe(0);
  });

  it('rechaza un maximo invalido', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(1.5)).toThrow();
  });
});
