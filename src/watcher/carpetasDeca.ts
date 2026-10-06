import { readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logging';

/**
 * Nombre de las carpetas de `watcher-rutas-deca`: `<fecha>--<ruta>`, p.ej.
 * `2026-10-05T17-25-02--RT00013415_2026_susmedios`. La fecha va PRIMERO para que el orden alfabetico
 * (el del explorador de ficheros) coincida con el cronologico, igual que en los JSON de eventos.
 * La fecha es la de CREACION del DECA (la mas antigua si la ruta tiene varios envios): no cambia en
 * las siguientes actualizaciones, asi que la carpeta no se renombra cada vez.
 */
const PREFIJO = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}--/;

const dos = (n: number): string => String(n).padStart(2, '0');

/** `2026-10-05T17-25-02` en hora local. */
function formatear(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}-${dos(d.getMinutes())}-${dos(d.getSeconds())}`;
}

/** "05/10/2026 17:25:02" (formato de LUX, hora local) -> ms, o `undefined` si no es una fecha. */
export function parseFechaLux(texto: string | undefined): number | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{1,2}):(\d{2}):(\d{2}))?/.exec(texto ?? '');
  if (!m) {
    return undefined;
  }
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)).getTime();
}

/** Prefijo de fecha: la fecha de creacion mas antigua de los envios DECA; si ninguno la trae, `respaldoMs`. */
export function prefijoFecha(fechasCreacion: Array<string | undefined>, respaldoMs: number): string {
  const fechas = fechasCreacion.map(parseFechaLux).filter((t): t is number => t !== undefined);
  return formatear(fechas.length > 0 ? Math.min(...fechas) : respaldoMs);
}

export function nombreCarpetaRuta(prefijo: string, nombreRuta: string): string {
  return `${prefijo}--${nombreRuta}`;
}

/** Carpeta que ya existe para esa ruta: la actual (`<fecha>--<ruta>`) o la antigua (solo `<ruta>`). */
export async function buscarCarpetaDeRuta(raiz: string, nombreRuta: string): Promise<string | undefined> {
  let nombres: string[];
  try {
    nombres = await readdir(raiz);
  } catch {
    return undefined;
  }
  const actual = nombres.filter((n) => PREFIJO.test(n) && n.slice(n.indexOf('--') + 2) === nombreRuta).sort();
  if (actual.length > 0) {
    return actual[0];
  }
  return nombres.includes(nombreRuta) ? nombreRuta : undefined;
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}

/**
 * Renombra las carpetas con el esquema antiguo (`<ruta>`) al nuevo (`<fecha>--<ruta>`), sacando la fecha
 * del JSON que contienen (creacion del DECA o, en su defecto, `consultadoEn`, o la fecha de la carpeta).
 * Es idempotente y no toca lo que ya tiene fecha. Devuelve cuantas carpetas renombro.
 */
export async function migrarCarpetas(raiz: string, logger?: Logger): Promise<number> {
  let nombres: string[];
  try {
    nombres = await readdir(raiz);
  } catch {
    return 0;
  }
  let renombradas = 0;
  for (const nombre of nombres) {
    const ruta = join(raiz, nombre);
    if (PREFIJO.test(nombre) || !(await stat(ruta)).isDirectory()) {
      continue;
    }
    let respaldo = (await stat(ruta)).mtimeMs;
    let fechas: Array<string | undefined> = [];
    try {
      const json = (await readdir(ruta)).filter((f) => f.endsWith('.json')).sort().at(-1);
      if (json) {
        const datos = JSON.parse(await readFile(join(ruta, json), 'utf-8')) as {
          deca?: Array<{ fechaCreacion?: string }>;
          consultadoEn?: string;
        };
        fechas = (datos.deca ?? []).map((d) => d.fechaCreacion);
        const consultado = datos.consultadoEn ? Date.parse(datos.consultadoEn) : NaN;
        if (!Number.isNaN(consultado)) {
          respaldo = consultado;
        }
      }
    } catch {
      // JSON ilegible: se usa la fecha de la carpeta
    }
    const destino = nombreCarpetaRuta(prefijoFecha(fechas, respaldo), nombre);
    if (await existe(join(raiz, destino))) {
      continue;
    }
    try {
      await rename(ruta, join(raiz, destino));
      renombradas += 1;
    } catch (err) {
      // Una carpeta en uso (Windows no deja renombrar una carpeta con ficheros abiertos) no debe
      // impedir renombrar las demas: se avisa y se sigue; se reintentara en el siguiente arranque.
      logger?.warn('No se pudo renombrar una carpeta de watcher-rutas-deca (se reintenta al arrancar)', {
        operacion: 'watcher.carpetasDeca.error',
        resultado: 'ERROR',
        carpeta: nombre,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (renombradas > 0) {
    logger?.info('Carpetas de watcher-rutas-deca renombradas con la fecha delante', {
      operacion: 'watcher.carpetasDeca.migradas',
      resultado: 'OK',
      cantidad: renombradas,
    });
  }
  return renombradas;
}
