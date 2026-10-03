import { hlcFromMs, hlcPredecessor, isHlc } from './hlc';
import { uuid } from './ids';
import { EVENT_TYPES, SCHEMA_VERSION, type Change, type EventType, type FieldValue, type RgEvent } from './types';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface NewEventInput {
  hlc: string;
  author: string;
  deviceId: string;
  recordId: string;
  type: EventType;
  changes: Record<string, Change>;
  baseRev: string | null;
  now?: Date;
}

export function makeEvent(input: NewEventInput): RgEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uuid(),
    ts: (input.now ?? new Date()).toISOString(),
    hlc: input.hlc,
    author: input.author,
    deviceId: input.deviceId,
    recordId: input.recordId,
    type: input.type,
    changes: input.changes,
    baseRev: input.baseRev,
  };
}

/**
 * ISO 8601 UTC adaptado a nomes de ficheiro Windows (":" e "." não são válidos
 * ou são problemáticos): 2026-10-03T12:34:56.789Z -> 2026-10-03T12-34-56-789Z
 */
export function isoForFileName(iso: string): string {
  const d = new Date(iso);
  const s = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return s.replace(/:/g, '-').replace('.', '-');
}

export function eventDir(ev: Pick<RgEvent, 'ts'>): [string, string] {
  const d = new Date(ev.ts);
  const ok = !Number.isNaN(d.getTime());
  const y = ok ? d.getUTCFullYear() : new Date().getUTCFullYear();
  const m = (ok ? d.getUTCMonth() : new Date().getUTCMonth()) + 1;
  return [String(y), String(m).padStart(2, '0')];
}

export function eventFileName(ev: Pick<RgEvent, 'ts' | 'deviceId' | 'id'>): string {
  return `${isoForFileName(ev.ts)}_${ev.deviceId}_${ev.id}.json`;
}

/** Caminho relativo à pasta RegistoGravidas, com "/" como separador. */
export function eventRelPath(ev: Pick<RgEvent, 'ts' | 'deviceId' | 'id'>): string {
  const [y, m] = eventDir(ev);
  return `data/events/${y}/${m}/${eventFileName(ev)}`;
}

export function serializeEvent(ev: RgEvent): string {
  return JSON.stringify(ev, null, 2) + '\n';
}

export type ParseResult<T> = { ok: true; value: T; migrated: boolean } | { ok: false; reason: string };

function toFieldValue(v: unknown): FieldValue | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Valida e normaliza um evento lido de disco. Tolera versões antigas do esquema
 * (campos em falta que se conseguem derivar) e rejeita, com motivo legível,
 * o que não se consegue interpretar com segurança.
 */
export function normalizeEvent(raw: unknown): ParseResult<RgEvent> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'não é um objeto JSON' };
  }
  const o = raw as Record<string, unknown>;
  let migrated = false;

  let schemaVersion = o.schemaVersion;
  if (schemaVersion === undefined) {
    schemaVersion = 0;
    migrated = true;
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    return { ok: false, reason: 'schemaVersion inválido' };
  }
  if (schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `criado por uma versão mais recente da aplicação (schemaVersion ${schemaVersion}); atualize o index.html`,
    };
  }
  if (schemaVersion < SCHEMA_VERSION) migrated = true;

  const id = o.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) return { ok: false, reason: 'id em falta ou inválido' };

  const recordId = o.recordId;
  if (typeof recordId !== 'string' || recordId.length === 0 || recordId.length > 100) {
    return { ok: false, reason: 'recordId em falta ou inválido' };
  }

  const type = o.type;
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `tipo de evento desconhecido (${String(type)})` };
  }

  let ts = typeof o.ts === 'string' ? o.ts : undefined;
  const tsMs = ts ? Date.parse(ts) : NaN;
  let hlc = isHlc(o.hlc) ? (o.hlc as string) : undefined;
  if (!hlc) {
    if (Number.isNaN(tsMs)) return { ok: false, reason: 'sem hlc nem data (ts) válida' };
    hlc = hlcFromMs(tsMs);
    migrated = true;
  }
  if (!ts || Number.isNaN(tsMs)) {
    ts = new Date(Number(hlc.slice(0, 15))).toISOString();
    migrated = true;
  }

  if (typeof o.changes !== 'object' || o.changes === null || Array.isArray(o.changes)) {
    return { ok: false, reason: 'changes em falta ou inválido' };
  }
  const changes: Record<string, Change> = {};
  for (const [field, ch] of Object.entries(o.changes as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(field) || field.length > 60) continue;
    if (typeof ch !== 'object' || ch === null) continue;
    const c = ch as Record<string, unknown>;
    const to = toFieldValue(c.to);
    if (to === undefined) continue;
    const from = toFieldValue(c.from);
    changes[field] = { from: from === undefined ? null : from, to };
  }

  let baseRev: string | null;
  if (o.baseRev === undefined) {
    // Esquema antigo sem baseRev: assume-se que o autor viu tudo o que é anterior
    // ao próprio evento (sem deteção de conflito, apenas last-writer-wins).
    baseRev = type === 'create' ? null : hlcPredecessor(hlc);
    migrated = true;
  } else if (o.baseRev === null) {
    baseRev = null;
  } else if (isHlc(o.baseRev)) {
    baseRev = o.baseRev as string;
  } else {
    return { ok: false, reason: 'baseRev inválido' };
  }
  // Um evento não pode ter "visto" algo posterior a si próprio.
  if (baseRev !== null && baseRev >= hlc) baseRev = hlcPredecessor(hlc);

  const author = typeof o.author === 'string' && o.author.trim() ? o.author.trim().slice(0, 120) : '(desconhecido)';
  const deviceId = typeof o.deviceId === 'string' && o.deviceId ? o.deviceId.slice(0, 60) : 'desconhecido';

  return {
    ok: true,
    migrated,
    value: {
      schemaVersion: SCHEMA_VERSION,
      id,
      ts,
      hlc,
      author,
      deviceId,
      recordId,
      type: type as EventType,
      changes,
      baseRev,
    },
  };
}

export function parseEventText(text: string): ParseResult<RgEvent> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'JSON inválido ou incompleto (talvez ainda a sincronizar)' };
  }
  return normalizeEvent(raw);
}

/** Ordem total determinística: (hlc, deviceId, id). */
export function compareEvents(a: Pick<RgEvent, 'hlc' | 'deviceId' | 'id'>, b: Pick<RgEvent, 'hlc' | 'deviceId' | 'id'>): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
