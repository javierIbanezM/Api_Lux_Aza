import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFechaLux } from './carpetasDeca';

/**
 * Carpetas de `watcher-rutas-deca` que hay que volver a mirar en LUX. Dos casos:
 *
 *  - INCOMPLETAS: el JSON mas reciente tiene un envio sin `shipmentId` (el envio a Docuten no se habia
 *    creado al consultarlo) o, teniendo ya `shipmentId`, la carpeta no contiene ningun PDF descargado.
 *  - EN SEGUIMIENTO: el DECA esta completo pero su envio aun no ha llegado al final de su ciclo
 *    (ENVIADO/created -> FIRMADO/ready_for_pickup -> FIRMADO/pending_delivery -> FIRMADO/delivered).
 *    Docuten actualiza el PDF (con la firma, y luego con la entrega) SIN que quede ningun evento en
 *    los logs de LUX, asi que hay que comparar el estado del DECA con el guardado y, si cambio,
 *    volver a descargar los documentos.
 *
 * Los envios en estado terminal (`ANULADO`, `ERROR`) no cuentan: Docuten/LUX los dio por fallidos y
 * nunca tendran documento (se reabren al volver a generar el DECA).
 */
const ESTADOS_TERMINALES = /^(ANULADO|ERROR)$/i;
/** Estado del envio en Docuten cuando ya esta entregado: no se vuelve a mirar. */
const ENVIO_ENTREGADO = /^delivered$/i;
const DIA_MS = 24 * 3600_000;

export type MotivoPendiente = 'sin-shipmentId' | 'sin-pdf' | 'sin-totales' | 'seguimiento';

export interface DecaPendiente {
  carpeta: string;
  numeroRuta: string;
  almacen?: string;
  motivo: MotivoPendiente;
  /** Firma del estado guardado (ver `firmaDeca`): solo en los de `seguimiento`, para detectar cambios. */
  firma?: string;
}

type FilaDeca = { estado?: string; shipmentStatus?: string; documentStatus?: string; fechaEnvio?: string; shipmentId?: string; fechaCreacion?: string };

interface JsonRutaDeca {
  numeroRuta?: string;
  almacen?: string;
  consultadoEn?: string;
  numContenedores?: number | null;
  deca?: FilaDeca[];
}

/** Resumen del estado de un DECA (estado en LUX + estado del envio y del documento en Docuten), para comparar. */
export function firmaDeca(filas: FilaDeca[]): string {
  return filas
    .map((d) => [d.shipmentId, d.estado, d.shipmentStatus, d.documentStatus, d.fechaEnvio].map((v) => (v ?? '').trim()).join('|'))
    .sort()
    .join(';');
}

export interface OpcionesBusqueda {
  /** Dias, desde la creacion del DECA, durante los que se sigue su estado. Por defecto 14. */
  seguimientoDias?: number;
  /** Para pruebas. */
  ahora?: number;
}

/** `conDocuten`: si no hay cliente de Docuten no se pueden descargar PDF, asi que su falta no es un pendiente. */
export async function buscarDecaPendientes(raiz: string, conDocuten: boolean, opciones: OpcionesBusqueda = {}): Promise<DecaPendiente[]> {
  const ahora = opciones.ahora ?? Date.now();
  const limiteSeguimiento = (opciones.seguimientoDias ?? 14) * DIA_MS;
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
      if (numeroRuta === '') {
        continue;
      }
      const base = { carpeta, numeroRuta, almacen: datos.almacen };
      // Carpetas guardadas antes de existir los totales de la ruta (pallets / numContenedores): se rellenan una
      // vez, tambien las de envios fallidos (ERROR/ANULADO), que por lo demas no se vuelven a mirar.
      if (datos.numContenedores === undefined) {
        pendientes.push({ ...base, motivo: 'sin-totales' });
        continue;
      }
      const envios = (datos.deca ?? []).filter((d) => !ESTADOS_TERMINALES.test((d.estado ?? '').trim()));
      if (envios.length === 0) {
        continue;
      }
      const sinId = envios.some((d) => (d.shipmentId ?? '').trim() === '');
      const sinPdf = conDocuten && !ficheros.some((f) => f.toLowerCase().endsWith('.pdf'));
      if (sinId || sinPdf) {
        pendientes.push({ ...base, motivo: sinId ? 'sin-shipmentId' : 'sin-pdf' });
        continue;
      }
      // Completo: sigue en seguimiento mientras algun envio no este entregado y el DECA sea reciente.
      const sinEntregar = envios.some((d) => !ENVIO_ENTREGADO.test((d.shipmentStatus ?? '').trim()));
      const creado = Math.min(...envios.map((d) => parseFechaLux(d.fechaCreacion) ?? Number.POSITIVE_INFINITY), Date.parse(datos.consultadoEn ?? '') || Number.POSITIVE_INFINITY);
      const antiguedad = Number.isFinite(creado) ? ahora - creado : 0;
      if (conDocuten && sinEntregar && antiguedad <= limiteSeguimiento) {
        pendientes.push({ ...base, motivo: 'seguimiento', firma: firmaDeca(datos.deca ?? []) });
      }
    } catch {
      // carpeta o JSON ilegible: no es un pendiente que se pueda resolver aqui
    }
  }
  return pendientes;
}
