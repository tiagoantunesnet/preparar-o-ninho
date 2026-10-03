/**
 * Merge determinístico dos eventos.
 *
 * Valor de cada campo: last-writer-wins pela ordem (hlc, deviceId, id).
 *
 * Conflitos: para cada campo mantém-se o conjunto de "cabeças" — alterações a
 * esse campo que nenhuma outra alteração posterior "viu". A alteração X viu Y
 * quando X.baseRev >= Y.hlc (baseRev = último hlc do registo visto por quem
 * editou). Se ficarem duas ou mais cabeças com valores diferentes, o campo
 * está em conflito. O caso descrito na especificação — duas alterações ao mesmo
 * campo com o mesmo baseRev — é exatamente este (nenhuma viu a outra). Um evento
 * `resolve` tem baseRev >= todas as cabeças e por isso substitui-as.
 *
 * Propriedade essencial: o resultado não depende da ordem de chegada dos eventos
 * (a relação "viu" é transitiva porque hlc > baseRev em cada evento), pelo que
 * snapshot + eventos tardios == aplicar tudo de raiz. Há testes para isto.
 */
import { compareEvents } from './events';
import type { EventType, FieldValue, RgEvent } from './types';

export interface Head {
  eventId: string;
  hlc: string;
  baseRev: string | null;
  deviceId: string;
  author: string;
  ts: string;
  type: EventType;
  value: FieldValue;
}

export interface FieldState {
  value: FieldValue;
  eventId: string;
  hlc: string;
  deviceId: string;
  author: string;
  ts: string;
  heads: Head[];
}

export interface HistoryEntry {
  eventId: string;
  hlc: string;
  ts: string;
  author: string;
  deviceId: string;
  type: EventType;
  field: string;
  from: FieldValue;
  to: FieldValue;
}

export interface Stamp {
  hlc: string;
  ts: string;
  author: string;
  deviceId: string;
  type: EventType;
  eventId: string;
}

export interface RecordState {
  recordId: string;
  hasCreate: boolean;
  created: Stamp | null;
  /** Maior hlc aplicado a este registo — é o baseRev da próxima edição. */
  rev: string;
  last: Stamp;
  fields: Record<string, FieldState>;
  history: HistoryEntry[];
}

export interface MergeState {
  records: Record<string, RecordState>;
  eventIds: Set<string>;
  maxHlc: string | null;
  /** Eventos ignorados por já terem sido aplicados (ficheiros duplicados). */
  duplicates: number;
}

export function emptyState(): MergeState {
  return { records: Object.create(null), eventIds: new Set(), maxHlc: null, duplicates: 0 };
}

type Ordered = { hlc: string; deviceId: string; eventId: string };
function cmp(a: Ordered, b: Ordered): number {
  return compareEvents({ hlc: a.hlc, deviceId: a.deviceId, id: a.eventId }, { hlc: b.hlc, deviceId: b.deviceId, id: b.eventId });
}

/** x viu y? */
function sees(x: { baseRev: string | null }, y: { hlc: string }): boolean {
  return x.baseRev !== null && x.baseRev >= y.hlc;
}

function stampOf(ev: RgEvent): Stamp {
  return { hlc: ev.hlc, ts: ev.ts, author: ev.author, deviceId: ev.deviceId, type: ev.type, eventId: ev.id };
}

function insertSorted<T>(arr: T[], item: T, compare: (a: T, b: T) => number): void {
  let i = arr.length;
  while (i > 0 && compare(arr[i - 1], item) > 0) i--;
  arr.splice(i, 0, item);
}

function historyCmp(a: HistoryEntry, b: HistoryEntry): number {
  const c = cmp(a, b);
  if (c !== 0) return c;
  return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
}

function headCmp(a: Head, b: Head): number {
  return cmp(a, b);
}

function applyToField(rec: RecordState, field: string, ev: RgEvent, value: FieldValue): void {
  const head: Head = {
    eventId: ev.id,
    hlc: ev.hlc,
    baseRev: ev.baseRev,
    deviceId: ev.deviceId,
    author: ev.author,
    ts: ev.ts,
    type: ev.type,
    value,
  };
  const fs = rec.fields[field];
  if (!fs) {
    rec.fields[field] = {
      value,
      eventId: ev.id,
      hlc: ev.hlc,
      deviceId: ev.deviceId,
      author: ev.author,
      ts: ev.ts,
      heads: [head],
    };
    return;
  }
  const heads = fs.heads.filter((h) => !sees(head, h));
  if (!heads.some((h) => sees(h, head))) insertSorted(heads, head, headCmp);
  fs.heads = heads;
  if (cmp(head, fs) > 0) {
    fs.value = value;
    fs.eventId = ev.id;
    fs.hlc = ev.hlc;
    fs.deviceId = ev.deviceId;
    fs.author = ev.author;
    fs.ts = ev.ts;
  }
}

/** Aplica um evento (mutável). Devolve false se já tinha sido aplicado. */
export function applyEvent(state: MergeState, ev: RgEvent): boolean {
  if (state.eventIds.has(ev.id)) {
    state.duplicates++;
    return false;
  }
  state.eventIds.add(ev.id);
  if (!state.maxHlc || ev.hlc > state.maxHlc) state.maxHlc = ev.hlc;

  const stamp = stampOf(ev);
  let rec = state.records[ev.recordId];
  if (!rec) {
    rec = {
      recordId: ev.recordId,
      hasCreate: false,
      created: null,
      rev: ev.hlc,
      last: stamp,
      fields: Object.create(null),
      history: [],
    };
    state.records[ev.recordId] = rec;
  }
  if (ev.type === 'create') {
    rec.hasCreate = true;
    if (!rec.created || cmp(stamp, rec.created) < 0) rec.created = stamp;
  }
  if (ev.hlc > rec.rev) rec.rev = ev.hlc;
  if (cmp(stamp, rec.last) > 0) rec.last = stamp;

  for (const [field, ch] of Object.entries(ev.changes)) {
    applyToField(rec, field, ev, ch.to);
    insertSorted(
      rec.history,
      {
        eventId: ev.id,
        hlc: ev.hlc,
        ts: ev.ts,
        author: ev.author,
        deviceId: ev.deviceId,
        type: ev.type,
        field,
        from: ch.from,
        to: ch.to,
      },
      historyCmp,
    );
  }
  return true;
}

/** Aplica uma lista de eventos por ordem (hlc, deviceId, id). */
export function applyEvents(state: MergeState, events: Iterable<RgEvent>): MergeState {
  const sorted = [...events].sort(compareEvents);
  for (const ev of sorted) applyEvent(state, ev);
  return state;
}

export function stateFromEvents(events: Iterable<RgEvent>): MergeState {
  return applyEvents(emptyState(), events);
}

function cloneRecord(r: RecordState): RecordState {
  return JSON.parse(JSON.stringify(r)) as RecordState;
}

function mergeField(a: FieldState, b: FieldState): FieldState {
  const byId = new Map<string, Head>();
  for (const h of [...a.heads, ...b.heads]) byId.set(h.eventId, h);
  const all = [...byId.values()];
  const heads = all.filter((h) => !all.some((o) => o !== h && sees(o, h))).sort(headCmp);
  const w = cmp(a, b) >= 0 ? a : b;
  return { value: w.value, eventId: w.eventId, hlc: w.hlc, deviceId: w.deviceId, author: w.author, ts: w.ts, heads };
}

/** União de dois estados de registo (usada ao combinar snapshots). */
export function mergeRecords(a: RecordState, b: RecordState): RecordState {
  const out = cloneRecord(a);
  out.hasCreate = a.hasCreate || b.hasCreate;
  if (b.created && (!out.created || cmp(b.created, out.created) < 0)) out.created = { ...b.created };
  if (b.rev > out.rev) out.rev = b.rev;
  if (cmp(b.last, out.last) > 0) out.last = { ...b.last };
  for (const [field, fb] of Object.entries(b.fields)) {
    const fa = out.fields[field];
    out.fields[field] = fa ? mergeField(fa, fb) : (JSON.parse(JSON.stringify(fb)) as FieldState);
  }
  const seen = new Set(out.history.map((h) => h.eventId + '\u0000' + h.field));
  for (const h of b.history) {
    if (!seen.has(h.eventId + '\u0000' + h.field)) insertSorted(out.history, { ...h }, historyCmp);
  }
  return out;
}

/** Junta um estado (p.ex. de um snapshot) num estado acumulado (mutável). */
export function mergeStateInto(target: MergeState, src: { records: Record<string, RecordState>; eventIds: Iterable<string> }): void {
  for (const id of src.eventIds) target.eventIds.add(id);
  for (const [rid, r] of Object.entries(src.records)) {
    const cur = target.records[rid];
    target.records[rid] = cur ? mergeRecords(cur, r) : cloneRecord(r);
    const rec = target.records[rid];
    if (!target.maxHlc || rec.rev > target.maxHlc) target.maxHlc = rec.rev;
  }
}

/** Valores efetivos de um registo. */
export function recordValues(rec: RecordState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [f, fs] of Object.entries(rec.fields)) out[f] = fs.value ?? '';
  return out;
}

/** Campos em conflito (cabeças concorrentes com valores diferentes). */
export function recordConflicts(rec: RecordState): string[] {
  const out: string[] = [];
  for (const [f, fs] of Object.entries(rec.fields)) {
    if (fs.heads.length > 1 && new Set(fs.heads.map((h) => h.value ?? '')).size > 1) out.push(f);
  }
  return out.sort();
}

export function conflictHeads(rec: RecordState, field: string): Head[] {
  return rec.fields[field]?.heads ?? [];
}
