/** Meses abreviados en espanol, tal como los escribe el log de LUX (`05-oct-2026 12:43:50`). */
const MESES: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
};

/** Hora (ms, hora local) de una linea del log de LUX, o `undefined` si la linea no empieza por fecha. */
export function parseLogTime(linea: string): number | undefined {
  const m = /^(\d{2})-([a-z]{3})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2})/.exec(linea);
  if (!m) {
    return undefined;
  }
  const mes = MESES[m[2] as string];
  if (mes === undefined) {
    return undefined;
  }
  return new Date(Number(m[3]), mes, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}
