import { z } from 'zod';
import { isValidLuxDateString } from '../lux/utils';

/**
 * Validaciones basicas de entrada (formato), nunca reglas de negocio de Whales
 * (existencia de propietario/transportista/proveedor, etc. las valida LUX).
 */

/** Fecha "dd/MM/yyyy" o cadena vacia (equivale a "usar valor por defecto del SP"). */
export const luxDateString = z
  .string()
  .refine((value) => isValidLuxDateString(value), {
    message: 'La fecha debe tener formato dd/MM/yyyy',
  });

/** Cadena que representa un numero entero o decimal (LUX transporta todo como texto). */
export const numericString = z
  .string()
  .refine((value) => value.trim() !== '' && !Number.isNaN(Number(value)), {
    message: 'Debe ser una cadena numerica valida',
  });

/** Id de cabecera LUX: "0" (crear) o un id real numerico. */
export const idString = z.string().refine((value) => /^\d+$/.test(value), {
  message: 'El id debe ser una cadena numerica (p.ej. "0" o "1234")',
});

export const nonEmptyString = z.string().min(1, 'No puede estar vacio');
