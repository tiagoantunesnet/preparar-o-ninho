import { diffDays, isIsoDate } from './dates';
import { ESTADOS, type AppConfig, type RecordValues } from './types';

export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSNS(s: string): string {
  return s.replace(/[\s.\-]/g, '');
}

export function normalizePhone(s: string): string {
  let d = s.replace(/[\s.\-()/]/g, '');
  if (/^\+351\d{9}$/.test(d)) d = d.slice(4);
  else if (/^00351\d{9}$/.test(d)) d = d.slice(5);
  else if (/^351\d{9}$/.test(d)) d = d.slice(3);
  return d;
}

export function isValidSNS(s: string): boolean {
  return /^\d{9}$/.test(s);
}

/** Número português: 9 dígitos, começa por 2 (fixo), 3, 8 ou 9 (móvel). */
export function isValidPtPhone(s: string): boolean {
  return /^[2389]\d{8}$/.test(s);
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/** Procura o valor canónico numa lista ignorando acentos, maiúsculas e espaços. */
export function canonicalChoice(value: string, options: readonly string[]): string | null {
  const f = foldText(value);
  if (!f) return null;
  return options.find((o) => foldText(o) === f) ?? null;
}

export interface ValidationContext {
  config: AppConfig;
  today: string;
  /** SNS -> IDs de registos que o usam (para aviso de duplicado). */
  snsIndex: Map<string, string[]>;
  recordId?: string;
}

export interface ValidationResult {
  errors: Record<string, string>;
  warnings: Record<string, string>;
}

export function validateRecord(v: RecordValues, ctx: ValidationContext): ValidationResult {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const val = (k: string) => (v[k] ?? '').trim();

  if (!val('Nome')) errors.Nome = 'O nome é obrigatório.';

  const sns = val('NumeroSNS');
  if (sns) {
    if (!isValidSNS(sns)) errors.NumeroSNS = 'O n.º SNS deve ter exatamente 9 dígitos.';
    else {
      const others = (ctx.snsIndex.get(sns) ?? []).filter((id) => id !== ctx.recordId);
      if (others.length) warnings.NumeroSNS = 'Já existe outro registo com este n.º SNS.';
    }
  }

  const email = val('Email');
  if (email && !isValidEmail(email)) errors.Email = 'Email inválido (exemplo: nome@dominio.pt).';

  const tel = val('Telefone');
  if (tel && !isValidPtPhone(tel)) errors.Telefone = 'Telefone inválido: 9 dígitos, a começar por 2, 3, 8 ou 9.';

  for (const k of ['DataNascimento', 'DUM', 'DPP', 'DataContacto']) {
    const d = val(k);
    if (d && !isIsoDate(d)) errors[k] = 'Data inválida. Use o formato dd/mm/aaaa.';
  }

  const dum = val('DUM');
  if (!dum) errors.DUM = errors.DUM ?? 'A DUM é obrigatória.';
  else if (isIsoDate(dum)) {
    const d = diffDays(dum, ctx.today)!;
    if (d < 0) errors.DUM = 'A DUM não pode ser no futuro.';
    else if (d > 45 * 7) warnings.DUM = 'A DUM tem mais de 45 semanas — confirme a data.';
  }

  const nasc = val('DataNascimento');
  if (nasc && isIsoDate(nasc)) {
    const d = diffDays(nasc, ctx.today)!;
    if (d < 0) errors.DataNascimento = 'A data de nascimento não pode ser no futuro.';
    else if (d < 10 * 365 || d > 65 * 365) warnings.DataNascimento = 'Idade pouco habitual — confirme a data de nascimento.';
  }

  const dpp = val('DPP');
  if (dpp && dum && isIsoDate(dpp) && isIsoDate(dum) && diffDays(dum, dpp)! <= 0) {
    errors.DPP = 'A DPP tem de ser posterior à DUM.';
  }

  const dc = val('DataContacto');
  if (dc && isIsoDate(dc) && diffDays(dc, ctx.today)! < 0) errors.DataContacto = 'A data do contacto não pode ser no futuro.';

  const uf = val('UnidadeFuncional');
  if (uf && !ctx.config.UnidadeFuncional.includes(uf)) warnings.UnidadeFuncional = 'Valor fora da lista de unidades.';
  const pc = val('ProvenienciaContacto');
  if (pc && !ctx.config.ProvenienciaContacto.includes(pc)) warnings.ProvenienciaContacto = 'Valor fora da lista.';

  const c = val('Contactada');
  if (c && c !== 'Sim' && c !== 'Não') errors.Contactada = 'Escolha Sim ou Não.';

  const e = val('Estado');
  if (e && !(ESTADOS as readonly string[]).includes(e)) errors.Estado = 'Estado inválido.';

  return { errors, warnings };
}
