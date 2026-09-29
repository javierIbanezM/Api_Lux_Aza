import { z } from 'zod';
import { idString, luxDateString, nonEmptyString, numericString } from './common';

/** Campos comunes de cabecera de expedicion, todos opcionales salvo los obligatorios al crear. */
const cabeceraOptionalFields = {
  pedido: z.string().optional(),
  clienteNombre: z.string().optional(),
  tipoPedido: z.string().optional(),
  fecha: luxDateString.optional(),
  prioridad: numericString.optional(),
  observaciones: z.string().optional(),
  pedidoCliente: z.string().optional(),
  bloqueo: z.string().optional(),
  direccion: z.string().optional(),
  cp: z.string().optional(),
  poblacion: z.string().optional(),
  provincia: z.string().optional(),
  pais: z.string().optional(),
  telefono: z.string().optional(),
  correo: z.string().optional(),
  contacto: z.string().optional(),
  razonSocial: z.string().optional(),
  // Datos extra: null (ausente) = no tocar, "" = borrar, valor = fijar.
  facturarTransporte: z.string().nullable().optional(),
  expedicion: z.string().nullable().optional(),
  observacionesAlbaran: z.string().nullable().optional(),
  observacionesAlmacen: z.string().nullable().optional(),
  carga: z.string().nullable().optional(),
  fechaEntrega: z.string().nullable().optional(),
};

export const crearExpedicionCabeceraSchema = z.object({
  propietario: nonEmptyString,
  codCliente: nonEmptyString,
  transportista: nonEmptyString,
  serviceLevel: nonEmptyString, // obligatorio al crear, ver docs §6.1
  ...cabeceraOptionalFields,
});
export type CrearExpedicionCabeceraDTO = z.infer<typeof crearExpedicionCabeceraSchema>;

export const actualizarExpedicionCabeceraSchema = z.object({
  idPedido: idString,
  propietario: nonEmptyString.optional(),
  codCliente: nonEmptyString.optional(),
  transportista: nonEmptyString.optional(),
  serviceLevel: z.string().optional(),
  ...cabeceraOptionalFields,
});
export type ActualizarExpedicionCabeceraDTO = z.infer<typeof actualizarExpedicionCabeceraSchema>;

export const lineaExpedicionSchema = z.object({
  pedido: z.string().optional(),
  idParent: z.string().optional(),
  referencia: nonEmptyString,
  cantidadPedida: numericString,
  linea: z.string().optional(),
  lote: z.string().optional(),
  bloqueo: z.string().optional(),
  observaciones: z.string().optional(),
  referenciaCliente: z.string().optional(),
  vidaUtil: luxDateString.optional(),
});
export type LineaExpedicionDTO = z.infer<typeof lineaExpedicionSchema>;

export const actualizarLineaExpedicionSchema = z.object({
  id: idString,
  pedido: z.string().optional(),
  idParent: z.string().optional(),
  referencia: z.string().optional(),
  cantidadPedida: numericString.optional(),
  linea: z.string().optional(),
  lote: z.string().optional(),
  bloqueo: z.string().optional(),
  observaciones: z.string().optional(),
  referenciaCliente: z.string().optional(),
  vidaUtil: luxDateString.optional(),
});
export type ActualizarLineaExpedicionDTO = z.infer<typeof actualizarLineaExpedicionSchema>;

export const crearExpedicionSchema = crearExpedicionCabeceraSchema.extend({
  // No se valida cada elemento con `lineaExpedicionSchema` a este nivel: ExpedicionesService
  // valida cada linea individualmente (ver `crearExpedicion`) para que una linea invalida no
  // impida crear/reportar la cabecera ni bloquee al resto de lineas validas del mismo lote.
  // El limite de 200 es puramente operativo (evitar payloads desproporcionados), no forma
  // parte del contrato documentado de LUX.
  lineas: z.array(z.unknown()).max(200).optional(),
});
export type CrearExpedicionDTO = z.infer<typeof crearExpedicionSchema>;

export const listarExpedicionesFiltersSchema = z.object({
  pedido: z.string().optional(),
  propietario: z.string().optional(),
  cliente: z.string().optional(),
  clienteNombre: z.string().optional(),
  estado: z.string().optional(),
  tipo: z.string().optional(),
  fecha: luxDateString.optional(),
  fecha_fin: luxDateString.optional(),
  fechaCreacion: luxDateString.optional(),
  fechaCreacion_fin: luxDateString.optional(),
  fechaCerrado: luxDateString.optional(),
  fechaCerrado_fin: luxDateString.optional(),
  expedicion: z.string().optional(),
  deliveryNumber: z.string().optional(),
  transportista: z.string().optional(),
  pedidoCliente: z.string().optional(),
  observaciones: z.string().optional(),
  agrupacion: z.string().optional(),
  prioridad: z.string().optional(),
  ruta: z.string().optional(),
  referencia: z.string().optional(),
  poblacion: z.string().optional(),
  pais: z.string().optional(),
  provincia: z.string().optional(),
});
export type ListarExpedicionesFiltersDTO = z.infer<typeof listarExpedicionesFiltersSchema>;
