import { z } from 'zod';
import { idString, luxDateString, nonEmptyString, numericString } from './common';

const cabeceraOptionalFields = {
  albaran: z.string().optional(),
  codProveedor: z.string().optional(),
  fecha: luxDateString.optional(),
  tipoAlbaran: z.string().optional(),
  ue: z.string().optional(),
  agencia: z.string().optional(),
  ubicacionRecepcion: z.string().optional(),
  empresa: z.string().optional(),
  bloqueo: z.string().optional(),
  observaciones: z.string().optional(),
  // Datos extra
  matricula: z.string().nullable().optional(),
  matRemolque: z.string().nullable().optional(),
  dni: z.string().nullable().optional(),
  nombre: z.string().nullable().optional(),
  apellidos: z.string().nullable().optional(),
  telefono: z.string().nullable().optional(),
  observacionesPDA: z.string().nullable().optional(),
  descarga: z.string().nullable().optional(),
};

export const crearRecepcionCabeceraSchema = z.object({
  propietario: nonEmptyString,
  ...cabeceraOptionalFields,
});
export type CrearRecepcionCabeceraDTO = z.infer<typeof crearRecepcionCabeceraSchema>;

export const actualizarRecepcionCabeceraSchema = z.object({
  idAlbaran: idString,
  propietario: nonEmptyString.optional(),
  ...cabeceraOptionalFields,
});
export type ActualizarRecepcionCabeceraDTO = z.infer<typeof actualizarRecepcionCabeceraSchema>;

export const lineaRecepcionSchema = z.object({
  idParent: nonEmptyString,
  referencia: nonEmptyString,
  piezasAlbaran: numericString,
  linea: z.string().optional(),
  lote: z.string().optional(),
  fechaCaducidad: luxDateString.optional(),
  observaciones: z.string().optional(),
  cliente: z.string().optional(),
  entrega: z.string().optional(),
  bloqueo: z.string().optional(),
});
export type LineaRecepcionDTO = z.infer<typeof lineaRecepcionSchema>;

export const actualizarLineaRecepcionSchema = z.object({
  id: idString,
  idParent: z.string().optional(),
  referencia: z.string().optional(),
  piezasAlbaran: numericString.optional(),
  linea: z.string().optional(),
  lote: z.string().optional(),
  fechaCaducidad: luxDateString.optional(),
  observaciones: z.string().optional(),
  cliente: z.string().optional(),
  entrega: z.string().optional(),
  bloqueo: z.string().optional(),
});
export type ActualizarLineaRecepcionDTO = z.infer<typeof actualizarLineaRecepcionSchema>;

export const crearRecepcionSchema = crearRecepcionCabeceraSchema.extend({
  // No se valida cada elemento con `lineaRecepcionSchema` a este nivel: RecepcionesService
  // valida cada linea individualmente (ver `crearRecepcion`) para que una linea invalida no
  // impida crear/reportar la cabecera ni bloquee al resto de lineas validas del mismo lote.
  // El limite de 200 es puramente operativo (evitar payloads desproporcionados), no forma
  // parte del contrato documentado de LUX.
  lineas: z.array(z.unknown()).max(200).optional(),
});
export type CrearRecepcionDTO = z.infer<typeof crearRecepcionSchema>;

export const listarRecepcionesFiltersSchema = z.object({
  albaran: z.string().optional(),
  matricula: z.string().optional(),
  proveedor: z.string().optional(),
  propietario: z.string().optional(),
  cliente: z.string().optional(),
  estado: z.string().optional(),
  tipo: z.string().optional(),
  observaciones: z.string().optional(),
  fechaPrevista: luxDateString.optional(),
  fechaPrevista_FIN: luxDateString.optional(),
  fechaRecepcion: luxDateString.optional(),
  fechaRecepcion_FIN: luxDateString.optional(),
});
export type ListarRecepcionesFiltersDTO = z.infer<typeof listarRecepcionesFiltersSchema>;
