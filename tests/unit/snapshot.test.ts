import { describe, expect, it } from 'vitest';
import { recordValues, stateFromEvents } from '../../src/core/merge';
import { buildState, makeSnapshot, parseSnapshotText, serializeSnapshot, snapshotFileName } from '../../src/core/snapshot';
import type { RgEvent } from '../../src/core/types';
import { SimDevice, World } from '../helpers/devices';

function history() {
  const w = new World();
  const a = new SimDevice('pca', w, 0, 'Ana');
  const b = new SimDevice('pcb', w, 4 * 60_000, 'Bruno');
  const off = new SimDevice('pcoff', w, -10 * 60_000, 'Offline');
  const evs: RgEvent[] = [];
  evs.push(a.create('r1', { Nome: 'Fictícia Um', DUM: '2026-03-01', Estado: 'Ativa' }));
  evs.push(a.create('r2', { Nome: 'Fictícia Dois', DUM: '2026-04-01', Estado: 'Ativa' }));
  b.receive(evs);
  off.receive(evs);
  w.advance(1000);
  evs.push(a.edit('r1', { Telefone: '911111111' }));
  evs.push(b.edit('r1', { Telefone: '922222222' })); // conflito com o de cima
  evs.push(b.edit('r2', { Contactada: 'Sim' }));
  return { w, a, b, off, evs };
}

describe('snapshots', () => {
  it('snapshot + eventos tardios == aplicar tudo de raiz (incluindo PC offline com hlc antigo)', () => {
    const { w, a, off, evs } = history();
    const snap = makeSnapshot(stateFromEvents(evs), { hlc: a.clock.tick(), author: 'Ana', deviceId: 'pca' });
    // Depois do snapshot: alterações novas e uma alteração tardia de um PC que esteve offline 3 dias
    w.advance(3 * 86_400_000);
    a.receive(evs);
    const late: RgEvent[] = [a.edit('r2', { Observacoes: 'depois do snapshot' })];
    const offEv = off.edit('r1', { Email: 'off@example.com' });
    const offEv2 = off.edit('r2', { Contactada: 'Não' }); // concorrente com b (não viu)
    late.push(offEv, offEv2);

    const viaSnapshot = buildState([snap], [...evs, ...late]);
    expect(viaSnapshot.coveredEvents).toBe(evs.length);
    expect(viaSnapshot.appliedEvents).toBe(late.length);
    const full = stateFromEvents([...evs, ...late]);
    expect(viaSnapshot.state.records).toEqual(full.records);
    expect(recordValues(viaSnapshot.state.records.r1).Email).toBe('off@example.com');
  });

  it('funciona também quando os eventos antigos já foram arquivados (só o snapshot)', () => {
    const { a, evs } = history();
    const snap = makeSnapshot(stateFromEvents(evs), { hlc: a.clock.tick(), author: 'Ana', deviceId: 'pca' });
    const r = buildState([snap], []);
    expect(r.state.records).toEqual(stateFromEvents(evs).records);
  });

  it('serializa e volta a ler; conflitos preservados', () => {
    const { a, evs } = history();
    const snap = makeSnapshot(stateFromEvents(evs), { hlc: a.clock.tick(), author: 'Ana', deviceId: 'pca' });
    const p = parseSnapshotText(serializeSnapshot(snap));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const st = buildState([p.value], []).state;
    expect(st.records.r1.fields.Telefone.heads).toHaveLength(2);
    expect(snapshotFileName(snap)).toMatch(/^snapshot_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_pca\.json$/);
  });

  it('dois snapshots divergentes (PC offline consolidou um estado antigo) são unidos sem perder dados', () => {
    const { w, a, off, evs } = history();
    const s1 = makeSnapshot(stateFromEvents(evs.slice(0, 2)), { hlc: off.clock.tick(), author: 'Offline', deviceId: 'pcoff' });
    w.advance(1000);
    const s2 = makeSnapshot(stateFromEvents(evs), { hlc: a.clock.tick(), author: 'Ana', deviceId: 'pca' });
    const extra = off.edit('r1', { Observacoes: 'nota offline' });
    const s3 = makeSnapshot(stateFromEvents([...evs.slice(0, 2), extra]), { hlc: off.clock.tick(), author: 'Offline', deviceId: 'pcoff' });
    const merged = buildState([s3, s1, s2], []).state;
    expect(merged.records).toEqual(stateFromEvents([...evs, extra]).records);
  });

  it('rejeita snapshots corrompidos ou truncados', () => {
    const { a, evs } = history();
    const snap = makeSnapshot(stateFromEvents(evs), { hlc: a.clock.tick(), author: 'Ana', deviceId: 'pca' });
    const text = serializeSnapshot(snap);
    expect(parseSnapshotText(text.slice(0, text.length / 2)).ok).toBe(false);
    expect(parseSnapshotText(JSON.stringify({ ...snap, eventIds: snap.eventIds.slice(1) })).ok).toBe(false);
    expect(parseSnapshotText(JSON.stringify({ ...snap, schemaVersion: 99 })).ok).toBe(false);
    expect(parseSnapshotText(JSON.stringify({ ...snap, records: { x: { recordId: 'x' } } })).ok).toBe(false);
  });
});
