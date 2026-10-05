import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { limpiarFiltroRuta } from '../services/rutas';

/**
 * Clave de una ruta consultada: almacen + filtro limpio en mayusculas. Es la MISMA que usa el
 * watcher para agrupar eventos (`ruta:<almacen>:<RUTA>`).
 */
export function claveRuta(almacen: string | undefined, filtro: string): string {
  return `ruta:${almacen ?? ''}:${limpiarFiltroRuta(filtro).toUpperCase()}`;
}

/**
 * Registro de consultas de ruta YA procesadas: para cada ruta, la hora (ms) del ultimo evento del
 * log que se proceso. Sirve para que la revision de `lux.log.1` y `lux.log.0` al arrancar no
 * repita lo que ya se hizo (tampoco las rutas sin DECA, que no dejan ningun fichero).
 *
 * Las horas del log son del reloj de LUX y las de los JSON del reloj de este equipo, que pueden
 * diferir (~30 s se ha visto): al comparar se da una tolerancia.
 */
export class RutasProcesadas {
  private marcas = new Map<string, number>();
  private cadena: Promise<void> = Promise.resolve();

  constructor(
    private readonly ruta: string,
    private readonly toleranciaMs: number = 120_000,
  ) {}

  /** Carga el registro. Si aun no existe (primera vez), lo inicializa con las consultas que ya
   *  dejaron salida en `data/watcher-rutas-deca/<ruta>/*.json` (`consultaOriginal`, `almacen`,
   *  `consultadoEn`), para no rehacerlas. Devuelve cuantas marcas hay. */
  async cargar(carpetaRutasDeca: string): Promise<number> {
    try {
      const datos = JSON.parse(await readFile(this.ruta, 'utf-8')) as { rutas?: Record<string, number> };
      this.marcas = new Map(Object.entries(datos.rutas ?? {}));
      return this.marcas.size;
    } catch {
      // Sin registro previo: se parte de lo que ya hay en disco.
    }
    for (const marca of await leerMarcasDeCarpetas(carpetaRutasDeca)) {
      this.marcar(marca.clave, marca.t);
    }
    await this.guardar();
    return this.marcas.size;
  }

  /** true si esa ruta ya se proceso para un evento igual o posterior a `t` (con tolerancia de reloj). */
  yaProcesada(clave: string, t: number): boolean {
    const marca = this.marcas.get(clave);
    return marca !== undefined && marca + this.toleranciaMs >= t;
  }

  /** Anota que la ruta se proceso hasta el evento `t` (se conserva la marca mas reciente). */
  marcar(clave: string, t: number): void {
    const previa = this.marcas.get(clave);
    if (previa === undefined || t > previa) {
      this.marcas.set(clave, t);
    }
  }

  /** Persiste el registro (escrituras encadenadas: nunca dos a la vez sobre el mismo fichero). */
  guardar(): Promise<void> {
    const instantanea = JSON.stringify({ version: 1, rutas: Object.fromEntries(this.marcas) });
    const escribir = async (): Promise<void> => {
      await mkdir(dirname(this.ruta), { recursive: true });
      await writeFile(this.ruta, instantanea, 'utf-8');
    };
    this.cadena = this.cadena.then(escribir, escribir);
    return this.cadena;
  }
}

/** Marcas deducidas de los JSON de ruta ya generados (una carpeta por ruta). */
export async function leerMarcasDeCarpetas(carpetaRutasDeca: string): Promise<Array<{ clave: string; t: number }>> {
  const marcas: Array<{ clave: string; t: number }> = [];
  let carpetas: string[];
  try {
    carpetas = await readdir(carpetaRutasDeca);
  } catch {
    return marcas;
  }
  for (const carpeta of carpetas) {
    let ficheros: string[];
    try {
      ficheros = await readdir(join(carpetaRutasDeca, carpeta));
    } catch {
      continue; // un fichero suelto (estructura antigua), no una carpeta de ruta
    }
    for (const nombre of ficheros.filter((f) => f.endsWith('.json'))) {
      try {
        const json = JSON.parse(await readFile(join(carpetaRutasDeca, carpeta, nombre), 'utf-8')) as {
          consultaOriginal?: string;
          almacen?: string;
          consultadoEn?: string;
        };
        const t = json.consultadoEn ? Date.parse(json.consultadoEn) : NaN;
        if (json.consultaOriginal && !Number.isNaN(t)) {
          marcas.push({ clave: claveRuta(json.almacen, json.consultaOriginal), t });
        }
      } catch {
        // JSON ilegible: se ignora
      }
    }
  }
  return marcas;
}
