/**
 * Importação do Excel original ("Grávidas 2026" / Tabela1).
 * Cabeçalho na linha 3, dados a partir da linha 4. Datas como números de série,
 * SNS e Telefone como números. Colunas calculadas (Semanas de Gravidez, Curso)
 * e Coluna1 são ignoradas.
 */
import { read, utils, type WorkBook, type WorkSheet } from 'xlsx';
import { defaultDpp, excelSerialToIso, isIsoDate, parsePtDate } from '../core/dates';
import type { AppConfig, RecordValues } from '../core/types';
import { canonicalChoice, foldText, isValidEmail, isValidPtPhone, isValidSNS, normalizePhone, normalizeSNS } from '../core/validation';

export const EXPECTED_SHEET = 'Grávidas 2026';
export const HEADER_ROW = 3;

type Target =
  | 'Nome'
  | 'NumeroSNS'
  | 'DataNascimento'
  | 'Email'
  | 'Telefone'
  | 'UnidadeFuncional'
  | 'MedicoAssistente'
  | 'DUM'
  | 'DPP'
  | 'ProvenienciaContacto'
  | 'Contactada'
  | 'ignore';

/** Cabeçalhos do Excel (comparados sem acentos/maiúsculas/espaços nas pontas — "DUM " incluído). */
const HEADER_MAP: Record<string, Target> = {
  nome: 'Nome',
  sns: 'NumeroSNS',
  'data nascimento': 'DataNascimento',
  email: 'Email',
  telefone: 'Telefone',
  'unidade funcional': 'UnidadeFuncional',
  'medico assistente': 'MedicoAssistente',
  'semanas de gravidez': 'ignore',
  dum: 'DUM',
  dpp: 'DPP',
  coluna1: 'ignore',
  'proveniencia do contacto': 'ProvenienciaContacto',
  curso: 'ignore',
  contactada: 'Contactada',
};

export type RowStatus = 'novo' | 'duplicado' | 'duplicado-ficheiro';

export interface ImportRow {
  rowNumber: number;
  values: RecordValues;
  warnings: string[];
  status: RowStatus;
}

export interface ImportPlan {
  sheetName: string;
  headerRow: number;
  rows: ImportRow[];
  emptyRows: number;
  ignoredColumns: string[];
  counts: { novos: number; duplicados: number; comAvisos: number };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

function findSheet(wb: WorkBook): { name: string; ws: WorkSheet } {
  const exact = wb.SheetNames.find((n) => n === EXPECTED_SHEET);
  const folded = exact ?? wb.SheetNames.find((n) => foldText(n) === foldText(EXPECTED_SHEET));
  const loose = folded ?? wb.SheetNames.find((n) => foldText(n).startsWith('gravidas'));
  if (!loose) throw new ImportError(`Não foi encontrada a folha "${EXPECTED_SHEET}". Folhas no ficheiro: ${wb.SheetNames.join(', ')}.`);
  return { name: loose, ws: wb.Sheets[loose] };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).replace(/ /g, ' ').trim();
}

function numberToDigits(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v).toLocaleString('en-US', { useGrouping: false });
  return cellText(v);
}

function toIsoDate(v: unknown, date1904: boolean): { iso: string; bad: boolean } {
  if (v === null || v === undefined || v === '') return { iso: '', bad: false };
  if (typeof v === 'number') {
    const iso = excelSerialToIso(v, date1904);
    return iso ? { iso, bad: false } : { iso: '', bad: true };
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { iso: `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`, bad: false };
  }
  const s = cellText(v);
  if (!s) return { iso: '', bad: false };
  const pt = parsePtDate(s);
  if (pt) return { iso: pt, bad: false };
  if (isIsoDate(s.slice(0, 10))) return { iso: s.slice(0, 10), bad: false };
  return { iso: '', bad: true };
}

function dupKey(v: RecordValues): string | null {
  if (v.NumeroSNS) return 'sns:' + v.NumeroSNS;
  if (v.Nome && v.DUM) return 'nd:' + foldText(v.Nome) + '|' + v.DUM;
  return null;
}

export interface ExistingIndex {
  sns: Set<string>;
  /** nome normalizado + "|" + DUM, para linhas sem SNS. */
  nameDum: Set<string>;
}

export function parseWorkbook(data: ArrayBuffer | Uint8Array, config: AppConfig, existing: ExistingIndex): ImportPlan {
  let wb: WorkBook;
  try {
    wb = read(data, { type: 'array', cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false });
  } catch (e) {
    throw new ImportError('Não foi possível ler o ficheiro Excel: ' + (e instanceof Error ? e.message : String(e)));
  }
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  const { name, ws } = findSheet(wb);
  const ref = ws['!ref'];
  if (!ref) throw new ImportError(`A folha "${name}" está vazia.`);
  const range = utils.decode_range(ref);
  const aoa = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const firstRow = range.s.r + 1; // n.º de linha (1-based) de aoa[0]

  const isHeader = (row: unknown[] | undefined) => {
    const f = new Set((row ?? []).map((c) => foldText(cellText(c))));
    return f.has('nome') && f.has('sns');
  };
  let headerIdx = HEADER_ROW - firstRow;
  if (!isHeader(aoa[headerIdx])) {
    headerIdx = aoa.slice(0, 20).findIndex((r) => isHeader(r));
    if (headerIdx < 0) throw new ImportError('Não foi encontrado o cabeçalho (linha com "Nome" e "SNS").');
  }
  const header = aoa[headerIdx] ?? [];
  const colMap: { col: number; target: Target }[] = [];
  const ignoredColumns: string[] = [];
  header.forEach((h, col) => {
    const label = cellText(h);
    if (!label) return;
    const t = HEADER_MAP[foldText(label)];
    if (t && t !== 'ignore') colMap.push({ col, target: t });
    else ignoredColumns.push(label);
  });
  const targets = new Set(colMap.map((c) => c.target));
  for (const req of ['Nome', 'DUM'] as const) {
    if (!targets.has(req)) throw new ImportError(`Falta a coluna obrigatória "${req === 'DUM' ? 'DUM' : 'Nome'}" no cabeçalho.`);
  }

  const rows: ImportRow[] = [];
  let emptyRows = 0;
  const seenInFile = new Set<string>();

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const raw = aoa[i] ?? [];
    const rowNumber = firstRow + i;
    const get = (t: Target): unknown => {
      const c = colMap.find((m) => m.target === t);
      return c ? raw[c.col] : null;
    };
    if (colMap.every(({ col }) => cellText(raw[col]) === '')) {
      emptyRows++;
      continue;
    }

    const w: string[] = [];
    const v: RecordValues = {};
    v.Nome = cellText(get('Nome'));
    if (!v.Nome) w.push('Nome em falta');

    const sns = normalizeSNS(numberToDigits(get('NumeroSNS')));
    if (sns) {
      v.NumeroSNS = sns;
      if (!isValidSNS(sns)) w.push(`SNS "${sns}" não tem 9 dígitos`);
    }

    for (const [t, label] of [
      ['DataNascimento', 'Data de nascimento'],
      ['DUM', 'DUM'],
      ['DPP', 'DPP'],
    ] as const) {
      const d = toIsoDate(get(t), date1904);
      if (d.bad) w.push(`${label} inválida ("${cellText(get(t))}")`);
      if (d.iso) v[t] = d.iso;
    }
    if (!v.DUM) w.push('DUM em falta');
    if (!v.DPP && v.DUM) v.DPP = defaultDpp(v.DUM) ?? '';

    const email = cellText(get('Email'));
    if (email) {
      v.Email = email;
      if (!isValidEmail(email)) w.push(`Email "${email}" inválido`);
    }

    const tel = normalizePhone(numberToDigits(get('Telefone')));
    if (tel) {
      v.Telefone = tel;
      if (!isValidPtPhone(tel)) w.push(`Telefone "${tel}" não é um número PT de 9 dígitos`);
    }

    const uf = cellText(get('UnidadeFuncional'));
    if (uf) {
      const c = canonicalChoice(uf, config.UnidadeFuncional);
      v.UnidadeFuncional = c ?? uf;
      if (!c) w.push(`Unidade funcional "${uf}" fora da lista`);
    }

    const med = cellText(get('MedicoAssistente'));
    if (med) v.MedicoAssistente = med;

    const prov = cellText(get('ProvenienciaContacto'));
    if (prov) {
      const c = canonicalChoice(prov, config.ProvenienciaContacto);
      v.ProvenienciaContacto = c ?? prov;
      if (!c) w.push(`Proveniência "${prov}" fora da lista`);
    }

    const cont = foldText(cellText(get('Contactada')));
    if (cont === 'sim' || cont === 's') v.Contactada = 'Sim';
    else if (cont === 'nao' || cont === 'n') v.Contactada = 'Não';
    else if (cont) w.push(`Contactada "${cellText(get('Contactada'))}" não reconhecido (deixado em branco)`);

    v.Estado = 'Ativa';
    if (w.length) v.AvisosImportacao = 'Importação: ' + w.join('; ');

    let status: RowStatus = 'novo';
    const key = dupKey(v);
    if (key) {
      if ((v.NumeroSNS && existing.sns.has(v.NumeroSNS)) || (!v.NumeroSNS && existing.nameDum.has(key.slice(3)))) status = 'duplicado';
      else if (seenInFile.has(key)) status = 'duplicado-ficheiro';
      seenInFile.add(key);
    }
    rows.push({ rowNumber, values: v, warnings: w, status });
  }

  const novos = rows.filter((r) => r.status === 'novo');
  return {
    sheetName: name,
    headerRow: firstRow + headerIdx,
    rows,
    emptyRows,
    ignoredColumns,
    counts: {
      novos: novos.length,
      duplicados: rows.length - novos.length,
      comAvisos: novos.filter((r) => r.warnings.length > 0).length,
    },
  };
}

export function nameDumKey(nome: string, dum: string): string {
  return foldText(nome) + '|' + dum;
}
