/**
 * Snapshots ("Consolidar"): estado completo + lista dos IDs de eventos incluídos.
 *
 * Estado atual = união de todos os snapshots válidos + eventos cujo ID não está
 * em nenhum deles. Quando os snapshots formam uma cadeia (cada um feito a partir
 * do anterior, o caso normal) a união é igual ao último snapshot válido; a união
 * protege o caso de um PC que esteve offline consolidar a partir de um estado antigo.
 */
import { compareEvents, isoForFileName } from './events';
import { isHlc } from './hlc';
import { uuid } from './ids';
import { applyEvent, emptyState, mergeStateInto, type MergeState, type RecordState } from './merge';
import { SCHEMA_VERSION, type RgEvent } from './types';
import type { ParseResult } from './events';

export interface SnapshotFile {
  schemaVersion: number;
  kind: 'snapshot';
  id: string;
  ts: string;
  hlc: string;
  author: string;
  deviceId: string;
  eventCount: number;
  eventIds: string[];
  records: Record<string, RecordState>;
}

export function makeSnapshot(state: MergeState, meta: { hlc: string; author: string; deviceId: string; now?: Date }): SnapshotFile {
  const eventIds = [...state.eventIds].sort();
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'snapshot',
    id: uuid(),
    ts: (meta.now ?? new Date()).toISOString(),
    hlc: meta.hlc,
    author: meta.author,
    deviceId: meta.deviceId,
    eventCount: eventIds.length,
    eventIds,
    records: JSON.parse(JSON.stringify(state.records)) as Record<string, RecordState>,
  };
}

export function snapshotFileName(s: Pick<SnapshotFile, 'ts' | 'deviceId'>): string {
  return `snapshot_${isoForFileName(s.ts)}_${s.deviceId}.json`;
}

export function serializeSnapshot(s: SnapshotFile): string {
  return JSON.stringify(s) + '\n';
}

function validRecord(r: unknown): r is RecordState {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  if (typeof o.recordId !== 'string' || typeof o.rev !== 'string' || !isHlc(o.rev)) return false;
  if (typeof o.fields !== 'object' || o.fields === null || !Array.isArray(o.history)) return false;
  if (typeof o.last !== 'object' || o.last === null) return false;
  for (const [k, f] of Object.entries(o.fields as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
    if (typeof f !== 'object' || f === null) return false;
    const fo = f as Record<string, unknown>;
    if (!Array.isArray(fo.heads) || typeof fo.hlc !== 'string') return false;
  }
  return true;
}

export function parseSnapshotText(text: string): ParseResult<SnapshotFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'JSON inválido ou incompleto (talvez ainda a sincronizar)' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'não é um objeto JSON' };
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'snapshot') return { ok: false, reason: 'não é um snapshot' };
  if (typeof o.schemaVersion !== 'number' || o.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, reason: `snapshot de versão não suportada (${String(o.schemaVersion)})` };
  }
  if (typeof o.id !== 'string' || typeof o.ts !== 'string' || !isHlc(o.hlc)) return { ok: false, reason: 'cabeçalho do snapshot inválido' };
  if (!Array.isArray(o.eventIds) || !o.eventIds.every((x) => typeof x === 'string')) {
    return { ok: false, reason: 'lista de eventos do snapshot inválida' };
  }
  if (typeof o.records !== 'object' || o.records === null) return { ok: false, reason: 'registos do snapshot inválidos' };
  if (typeof o.eventCount === 'number' && o.eventCount !== o.eventIds.length) {
    return { ok: false, reason: 'snapshot truncado (n.º de eventos não confere)' };
  }
  for (const r of Object.values(o.records as Record<string, unknown>)) {
    if (!validRecord(r)) return { ok: false, reason: 'registo inválido dentro do snapshot' };
  }
  return { ok: true, migrated: false, value: raw as SnapshotFile };
}

export interface BuildResult {
  state: MergeState;
  /** Eventos aplicados por cima dos snapshots. */
  appliedEvents: number;
  /** Eventos já incluídos num snapshot (ignorados). */
  coveredEvents: number;
}

export function buildState(snapshots: SnapshotFile[], events: Iterable<RgEvent>): BuildResult {
  const state = emptyState();
  const ordered = [...snapshots].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
  for (const s of ordered) mergeStateInto(state, s);
  const covered = new Set(state.eventIds);
  let appliedEvents = 0;
  let coveredEvents = 0;
  for (const ev of [...events].sort(compareEvents)) {
    if (covered.has(ev.id)) {
      coveredEvents++;
      continue;
    }
    if (applyEvent(state, ev)) appliedEvents++;
  }
  return { state, appliedEvents, coveredEvents };
}
