import { courseInProgress, courseStartsWithinWeeks, courseWindow, formatGestationalAge, gestationalAge, type CourseWindow, type GestationalAge } from './dates';
import { recordConflicts, recordValues, type MergeState, type RecordState, type Stamp } from './merge';
import { foldText } from './validation';

export interface RecordView {
  id: string;
  values: Record<string, string>;
  estado: string;
  conflicts: string[];
  rev: string;
  last: Stamp;
  created: Stamp | null;
  hasCreate: boolean;
  ga: GestationalAge | null;
  gaText: string;
  course: CourseWindow | null;
  needsReview: boolean;
  duplicateSNS: boolean;
  state: RecordState;
}

export function buildViews(state: MergeState, today: string): RecordView[] {
  const views: RecordView[] = [];
  for (const rec of Object.values(state.records)) {
    const values = recordValues(rec);
    const ga = gestationalAge(values.DUM, today);
    views.push({
      id: rec.recordId,
      values,
      estado: values.Estado || 'Ativa',
      conflicts: recordConflicts(rec),
      rev: rec.rev,
      last: rec.last,
      created: rec.created,
      hasCreate: rec.hasCreate,
      ga,
      gaText: formatGestationalAge(ga),
      course: courseWindow(values.DUM),
      needsReview: !!(values.AvisosImportacao ?? '').trim(),
      duplicateSNS: false,
      state: rec,
    });
  }
  const idx = snsIndex(views);
  for (const v of views) {
    const sns = v.values.NumeroSNS;
    if (sns && (idx.get(sns)?.length ?? 0) > 1) v.duplicateSNS = true;
  }
  return views;
}

/** SNS -> IDs dos registos não arquivados que o usam. */
export function snsIndex(views: RecordView[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const v of views) {
    const sns = (v.values.NumeroSNS ?? '').trim();
    if (!sns || v.estado === 'Arquivada') continue;
    const l = m.get(sns) ?? [];
    l.push(v.id);
    m.set(sns, l);
  }
  return m;
}

/** Todos os SNS conhecidos, incluindo arquivados (proteção na importação). */
export function allSNS(views: RecordView[]): Set<string> {
  const s = new Set<string>();
  for (const v of views) if (v.values.NumeroSNS) s.add(v.values.NumeroSNS.trim());
  return s;
}

export interface Filters {
  q: string;
  unidade: string;
  contactada: '' | 'Sim' | 'Não';
  estado: string; // '' = todos exceto arquivadas; '*' = todos
  conflito: boolean;
  rever: boolean;
  cursoSemanas: number | null;
}

export const DEFAULT_FILTERS: Filters = {
  q: '',
  unidade: '',
  contactada: '',
  estado: '',
  conflito: false,
  rever: false,
  cursoSemanas: null,
};

export function applyFilters(views: RecordView[], f: Filters, today: string): RecordView[] {
  const q = foldText(f.q);
  const qDigits = f.q.replace(/\D/g, '');
  return views.filter((v) => {
    if (q) {
      const nameHit = foldText(v.values.Nome ?? '').includes(q);
      const snsHit = qDigits.length > 0 && (v.values.NumeroSNS ?? '').includes(qDigits);
      if (!nameHit && !snsHit) return false;
    }
    if (f.unidade && v.values.UnidadeFuncional !== f.unidade) return false;
    if (f.contactada === 'Sim' && v.values.Contactada !== 'Sim') return false;
    if (f.contactada === 'Não' && v.values.Contactada === 'Sim') return false;
    if (f.estado === '' && v.estado === 'Arquivada') return false;
    if (f.estado && f.estado !== '*' && v.estado !== f.estado) return false;
    if (f.conflito && v.conflicts.length === 0) return false;
    if (f.rever && !v.needsReview) return false;
    if (f.cursoSemanas !== null && !courseStartsWithinWeeks(v.values.DUM, today, f.cursoSemanas)) return false;
    return true;
  });
}

export type SortKey = 'Nome' | 'NumeroSNS' | 'UnidadeFuncional' | 'DUM' | 'DPP' | 'IG' | 'Curso' | 'Contactada' | 'Estado' | 'Alterado';

export function sortViews(views: RecordView[], key: SortKey, dir: 'asc' | 'desc'): RecordView[] {
  const val = (v: RecordView): string | number => {
    switch (key) {
      case 'IG':
        return v.ga ? v.ga.totalDays : -1;
      case 'Curso':
        return v.course?.start ?? '';
      case 'Alterado':
        return v.rev;
      case 'Estado':
        return v.estado;
      default:
        return foldText(v.values[key] ?? '');
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...views].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === y) return foldText(a.values.Nome ?? '') < foldText(b.values.Nome ?? '') ? -1 : 1;
    // vazios sempre no fim
    if (x === '' || x === -1) return 1;
    if (y === '' || y === -1) return -1;
    return x < y ? -sign : sign;
  });
}

export interface ToContact {
  upcoming: RecordView[];
  inProgress: RecordView[];
}

/** Vista "A contactar": ativas, não contactadas, janela a começar nas próximas `weeks` semanas. */
export function toContact(views: RecordView[], today: string, weeks = 4): ToContact {
  const base = views.filter((v) => v.estado === 'Ativa' && v.values.Contactada !== 'Sim');
  const byStart = (a: RecordView, b: RecordView) => ((a.course?.start ?? '') < (b.course?.start ?? '') ? -1 : 1);
  return {
    upcoming: base.filter((v) => courseStartsWithinWeeks(v.values.DUM, today, weeks)).sort(byStart),
    inProgress: base.filter((v) => courseInProgress(v.values.DUM, today) && !courseStartsWithinWeeks(v.values.DUM, today, weeks)).sort(byStart),
  };
}
