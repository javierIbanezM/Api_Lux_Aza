import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * DECA de `watcher-rutas-deca` que aun no estan completos: el JSON mas reciente de la carpeta tiene un
 * envio sin `shipmentId` (el envio a Docuten no se habia creado al consultarlo) o, teniendo ya
 * `shipmentId`, la carpeta no contiene ningun PDF descargado. Se revisan al arrancar el watcher y
 * periodicamente hasta que queden completos.
 *
 * Los envios en estado terminal (`ANULADO`, `ERROR`) no cuentan: Docuten/LUX los dio por fallidos y
 * nunca tendran documento, reintentarlos seria un bucle sin fin (se reabren al volver a generar el DECA).
 */
const ESTADOS_TERMINALES = /^(ANULADO|ERROR)$/i;

export type MotivoPendiente = 'sin-shipmentId' | 'sin-pdf';

export interface DecaPendiente {
  carpeta: string;
  numeroRuta: string;
  almacen?: string;
  motivo: MotivoPendiente;
}

interface JsonRutaDeca {
  numeroRuta?: string;
  almacen?: string;
  deca?: Array<{ estado?: string; shipmentId?: string }>;
}

/** `conDocuten`: si no hay cliente de Docuten no se pueden descargar PDF, asi que su falta no es un pendiente. */
export async function buscarDecaPendientes(raiz: string, conDocuten: boolean): Promise<DecaPendiente[]> {
  let carpetas: string[];
  try {
    carpetas = (await readdir(raiz, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const pendientes: DecaPendiente[] = [];
  for (const carpeta of carpetas.sort()) {
    try {
      const ficheros = await readdir(join(raiz, carpeta));
      const json = ficheros.filter((f) => f.endsWith('.json')).sort().at(-1);
      if (!json) {
        continue;
      }
      const datos = JSON.parse(await readFile(join(raiz, carpeta, json), 'utf-8')) as JsonRutaDeca;
      const numeroRuta = (datos.numeroRuta ?? '').trim();
      const envios = (datos.deca ?? []).filter((d) => !ESTADOS_TERMINALES.test((d.estado ?? '').trim()));
      if (numeroRuta === '' || envios.length === 0) {
        continue;
      }
      const sinId = envios.some((d) => (d.shipmentId ?? '').trim() === '');
      const sinPdf = conDocuten && !ficheros.some((f) => f.toLowerCase().endsWith('.pdf'));
      if (sinId || sinPdf) {
        pendientes.push({ carpeta, numeroRuta, almacen: datos.almacen, motivo: sinId ? 'sin-shipmentId' : 'sin-pdf' });
      }
    } catch {
      // carpeta o JSON ilegible: no es un pendiente que se pueda resolver aqui
    }
  }
  return pendientes;
}
