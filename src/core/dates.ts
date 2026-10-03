/**
 * Datas de calendário guardadas como "AAAA-MM-DD" (sem hora nem fuso).
 * Toda a aritmética é feita em UTC para não ser afetada pela hora de verão.
 * Apresentação ao utilizador: dd/mm/aaaa.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export const COURSE_START_DAYS = 28 * 7;
export const COURSE_END_DAYS = 32 * 7;
export const DPP_DAYS = 280;

function toUtcMs(iso: string): number | null {
  const m = ISO_RE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && toUtcMs(s) !== null;
}

/** Data de hoje no fuso local do PC. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string | null {
  const ms = toUtcMs(iso);
  if (ms === null) return null;
  return fromUtcMs(ms + days * DAY_MS);
}

/** b - a, em dias. */
export function diffDays(a: string, b: string): number | null {
  const ma = toUtcMs(a);
  const mb = toUtcMs(b);
  if (ma === null || mb === null) return null;
  return Math.round((mb - ma) / DAY_MS);
}

/** "dd/mm/aaaa" (aceita também d/m/aaaa, com "-" ou "." como separador) -> ISO. */
export function parsePtDate(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

export function formatPtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = ISO_RE.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Data/hora ISO (com fuso) -> "dd/mm/aaaa hh:mm" na hora local. */
export function formatPtDateTime(isoTs: string | null | undefined, withSeconds = false): string {
  if (!isoTs) return '';
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
}

export interface GestationalAge {
  weeks: number;
  days: number;
  totalDays: number;
}

export function gestationalAge(dum: string | null | undefined, today: string): GestationalAge | null {
  if (!dum) return null;
  const total = diffDays(dum, today);
  if (total === null || total < 0) return null;
  return { weeks: Math.floor(total / 7), days: total % 7, totalDays: total };
}

export function formatGestationalAge(ga: GestationalAge | null): string {
  if (!ga) return '';
  return `${ga.weeks}s ${ga.days}d`;
}

export function defaultDpp(dum: string | null | undefined): string | null {
  return dum ? addDays(dum, DPP_DAYS) : null;
}

export interface CourseWindow {
  start: string;
  end: string;
}

/** Janela do curso: DUM + 28 semanas até DUM + 32 semanas. */
export function courseWindow(dum: string | null | undefined): CourseWindow | null {
  if (!dum || !isIsoDate(dum)) return null;
  return { start: addDays(dum, COURSE_START_DAYS)!, end: addDays(dum, COURSE_END_DAYS)! };
}

/** A janela do curso começa entre hoje e hoje + N semanas (inclusive)? */
export function courseStartsWithinWeeks(dum: string | null | undefined, today: string, weeks: number): boolean {
  const w = courseWindow(dum);
  if (!w) return false;
  const d = diffDays(today, w.start);
  return d !== null && d >= 0 && d <= weeks * 7;
}

/** Hoje está dentro da janela do curso? */
export function courseInProgress(dum: string | null | undefined, today: string): boolean {
  const w = courseWindow(dum);
  if (!w) return false;
  return w.start <= today && today <= w.end;
}

/**
 * Número de série do Excel -> ISO. Sistema 1900 (por omissão) ou 1904.
 * O sistema 1900 tem o falso dia 29/02/1900 (série 60); para séries > 60 o
 * epoch efetivo é 30/12/1899.
 */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const whole = Math.floor(serial + 1e-7);
  let ms: number;
  if (date1904) {
    ms = Date.UTC(1904, 0, 1) + whole * DAY_MS;
  } else if (whole >= 61) {
    ms = Date.UTC(1899, 11, 30) + whole * DAY_MS;
  } else if (whole === 60) {
    return null;
  } else {
    ms = Date.UTC(1899, 11, 31) + whole * DAY_MS;
  }
  return fromUtcMs(ms);
}
