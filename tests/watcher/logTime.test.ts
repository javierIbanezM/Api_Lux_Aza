import { describe, expect, it } from 'vitest';
import { parseLogTime } from '../../src/watcher/logTime';

describe('watcher/logTime', () => {
  it('lee la hora (local) de una linea del log de LUX con mes abreviado en espanol', () => {
    expect(parseLogTime('05-oct-2026 12:43:50 INFO:   [] exec p_x')).toBe(new Date(2026, 9, 5, 12, 43, 50).getTime());
    expect(parseLogTime('30-sep-2026 9:05:01 INFO:')).toBe(new Date(2026, 8, 30, 9, 5, 1).getTime());
  });

  it('devuelve undefined si la linea no empieza por una fecha valida', () => {
    expect(parseLogTime('com.microsoft.sqlserver.jdbc.SQLServerException: ...')).toBeUndefined();
    expect(parseLogTime('05-xxx-2026 12:43:50 INFO:')).toBeUndefined();
    expect(parseLogTime('')).toBeUndefined();
  });
});
