import { describe, expect, it } from 'vitest';
import {
  addDays,
  courseInProgress,
  courseStartsWithinWeeks,
  courseWindow,
  defaultDpp,
  diffDays,
  excelSerialToIso,
  formatGestationalAge,
  formatPtDate,
  gestationalAge,
  parsePtDate,
  todayIso,
} from '../../src/core/dates';

describe('datas', () => {
  it('dd/mm/aaaa <-> ISO, com validação de datas reais', () => {
    expect(parsePtDate('07/03/2026')).toBe('2026-03-07');
    expect(parsePtDate('7/3/2026')).toBe('2026-03-07');
    expect(parsePtDate('07-03-2026')).toBe('2026-03-07');
    expect(parsePtDate('31/02/2026')).toBeNull();
    expect(parsePtDate('29/02/2028')).toBe('2028-02-29');
    expect(parsePtDate('2026-03-07')).toBeNull();
    expect(formatPtDate('2026-03-07')).toBe('07/03/2026');
  });

  it('DPP por omissão = DUM + 280 dias', () => {
    expect(defaultDpp('2026-03-07')).toBe('2026-12-12');
    expect(defaultDpp('2025-12-31')).toBe('2026-10-07');
  });

  it('idade gestacional em semanas + dias', () => {
    expect(gestationalAge('2026-03-07', '2026-10-03')).toEqual({ weeks: 30, days: 0, totalDays: 210 });
    expect(formatGestationalAge(gestationalAge('2026-03-07', '2026-10-06'))).toBe('30s 3d');
    expect(gestationalAge('2026-03-07', '2026-03-07')).toEqual({ weeks: 0, days: 0, totalDays: 0 });
    expect(gestationalAge('2026-11-01', '2026-10-03')).toBeNull();
    expect(gestationalAge('', '2026-10-03')).toBeNull();
  });

  it('não é afetada pela mudança de hora (fim de março / fim de outubro)', () => {
    expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2);
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
  });

  it('janela do curso: DUM + 28 semanas até DUM + 32 semanas', () => {
    expect(courseWindow('2026-03-07')).toEqual({ start: '2026-09-19', end: '2026-10-17' });
    expect(courseStartsWithinWeeks('2026-03-07', '2026-09-01', 4)).toBe(true);
    expect(courseStartsWithinWeeks('2026-03-07', '2026-08-22', 4)).toBe(true); // exatamente 4 semanas
    expect(courseStartsWithinWeeks('2026-03-07', '2026-08-21', 4)).toBe(false);
    expect(courseStartsWithinWeeks('2026-03-07', '2026-09-20', 4)).toBe(false); // já começou
    expect(courseInProgress('2026-03-07', '2026-09-20')).toBe(true);
    expect(courseInProgress('2026-03-07', '2026-10-18')).toBe(false);
  });

  it('números de série do Excel (sistema 1900 e 1904)', () => {
    expect(excelSerialToIso(46088)).toBe('2026-03-07');
    expect(excelSerialToIso(34436)).toBe('1994-04-12');
    expect(excelSerialToIso(1)).toBe('1900-01-01');
    expect(excelSerialToIso(59)).toBe('1900-02-28');
    expect(excelSerialToIso(60)).toBeNull(); // 29/02/1900 não existe
    expect(excelSerialToIso(61)).toBe('1900-03-01');
    expect(excelSerialToIso(46088.75)).toBe('2026-03-07');
    expect(excelSerialToIso(0, true)).toBeNull();
    expect(excelSerialToIso(44626, true)).toBe('2026-03-07');
  });

  it('hoje no fuso local', () => {
    expect(todayIso(new Date(2026, 9, 3, 23, 59))).toBe('2026-10-03');
  });
});
