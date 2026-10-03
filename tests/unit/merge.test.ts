import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../src/core/events';
import { applyEvent, emptyState, recordConflicts, recordValues, stateFromEvents } from '../../src/core/merge';
import type { RgEvent } from '../../src/core/types';
import { shuffled, SimDevice, World } from '../helpers/devices';

const R = 'rec-1';
const MIN = 60_000;

function setup(skewA = 0, skewB = 0) {
  const w = new World();
  const a = new SimDevice('pca', w, skewA, 'Ana');
  const b = new SimDevice('pcb', w, skewB, 'Bruno');
  const create = a.create(R, { Nome: 'Teste Fictícia', DUM: '2026-03-01', Telefone: '910000000', Estado: 'Ativa' });
  w.advance(1000);
  b.receive([create]);
  return { w, a, b, create };
}

describe('merge — dois dispositivos em concorrência', () => {
  it('mesmo campo alterado a partir do mesmo baseRev → conflito, ambas as versões disponíveis', () => {
    const { w, a, b, create } = setup();
    const ea = a.edit(R, { Telefone: '911111111' });
    w.advance(5);
    const eb = b.edit(R, { Telefone: '922222222' });
    expect(ea.baseRev).toBe(create.hlc);
    expect(eb.baseRev).toBe(create.hlc);

    const s = stateFromEvents([create, ea, eb]);
    const rec = s.records[R];
    expect(recordConflicts(rec)).toEqual(['Telefone']);
    expect(rec.fields.Telefone.heads.map((h) => h.value).sort()).toEqual(['911111111', '922222222']);
    // LWW: eb tem hlc maior
    expect(recordValues(rec).Telefone).toBe('922222222');
  });

  it('campos diferentes em concorrência → sem conflito, ambas as alterações aplicadas', () => {
    const { a, b, create } = setup();
    const ea = a.edit(R, { Telefone: '911111111' });
    const eb = b.edit(R, { Email: 'teste@example.com' });
    const rec = stateFromEvents([create, ea, eb]).records[R];
    expect(recordConflicts(rec)).toEqual([]);
    expect(recordValues(rec)).toMatchObject({ Telefone: '911111111', Email: 'teste@example.com' });
  });

  it('mesmo valor em concorrência não é conflito', () => {
    const { a, b, create } = setup();
    const ea = a.edit(R, { Contactada: 'Sim' });
    const eb = b.edit(R, { Contactada: 'Sim' });
    expect(recordConflicts(stateFromEvents([create, ea, eb]).records[R])).toEqual([]);
  });

  it('alteração feita depois de ver a outra → sem conflito, a mais recente ganha', () => {
    const { w, a, b, create } = setup();
    const ea = a.edit(R, { Telefone: '911111111' });
    w.advance(1000);
    b.receive([ea]);
    const eb = b.edit(R, { Telefone: '933333333' });
    const rec = stateFromEvents([create, ea, eb]).records[R];
    expect(recordConflicts(rec)).toEqual([]);
    expect(recordValues(rec).Telefone).toBe('933333333');
  });

  it('evento resolve elimina o conflito e fica no histórico', () => {
    const { a, b, create } = setup();
    const ea = a.edit(R, { Telefone: '911111111' });
    const eb = b.edit(R, { Telefone: '922222222' });
    a.receive([eb]);
    const res = a.edit(R, { Telefone: '911111111' }, 'resolve');
    const rec = stateFromEvents([create, ea, eb, res]).records[R];
    expect(recordConflicts(rec)).toEqual([]);
    expect(recordValues(rec).Telefone).toBe('911111111');
    expect(rec.history.filter((x) => x.type === 'resolve')).toHaveLength(1);
  });

  it('três dispositivos: resolução que não viu uma terceira alteração concorrente mantém o conflito', () => {
    const { w, a, b, create } = setup();
    const c = new SimDevice('pcc', w, 0, 'Carla');
    c.receive([create]);
    const ea = a.edit(R, { Telefone: '911111111' });
    w.advance(7);
    const eb = b.edit(R, { Telefone: '922222222' });
    w.advance(13);
    const ec = c.edit(R, { Telefone: '944444444' }); // offline, não viu nada
    w.advance(1000);
    a.receive([eb]);
    const res = a.edit(R, { Telefone: '911111111' }, 'resolve');
    const rec = stateFromEvents([create, ea, eb, res, ec]).records[R];
    expect(recordConflicts(rec)).toEqual(['Telefone']);
    expect(rec.fields.Telefone.heads.map((h) => h.value).sort()).toEqual(['911111111', '944444444']);
  });

  it('arquivar e restaurar', () => {
    const { a, create } = setup();
    const arc = a.edit(R, { Estado: 'Arquivada' }, 'archive');
    expect(recordValues(stateFromEvents([create, arc]).records[R]).Estado).toBe('Arquivada');
    const rst = a.edit(R, { Estado: 'Ativa' }, 'restore');
    const rec = stateFromEvents([create, arc, rst]).records[R];
    expect(recordValues(rec).Estado).toBe('Ativa');
    expect(rec.history.map((x) => x.type)).toEqual(['create', 'create', 'create', 'create', 'archive', 'restore']);
  });
});

describe('merge — relógios desacertados (±10 min)', () => {
  it('PC atrasado 10 min que edita depois de ver a alteração do PC adiantado ganha (HLC)', () => {
    const { w, a, b, create } = setup(+10 * MIN, -10 * MIN);
    const ea = a.edit(R, { Telefone: '911111111' });
    w.advance(30_000);
    b.receive([ea]);
    const eb = b.edit(R, { Telefone: '922222222' });
    expect(eb.hlc > ea.hlc).toBe(true);
    // O ts físico de B é anterior ao de A, mas a ordem lógica está correta.
    expect(Date.parse(eb.ts)).toBeLessThan(Date.parse(ea.ts));
    const rec = stateFromEvents([create, ea, eb]).records[R];
    expect(recordValues(rec).Telefone).toBe('922222222');
    expect(recordConflicts(rec)).toEqual([]);
  });

  it('em concorrência com relógios desacertados o conflito é detetado na mesma', () => {
    const { w, a, b, create } = setup(+10 * MIN, -10 * MIN);
    const eb = b.edit(R, { Telefone: '922222222' });
    w.advance(60_000);
    const ea = a.edit(R, { Telefone: '911111111' });
    const rec = stateFromEvents([create, eb, ea]).records[R];
    expect(recordConflicts(rec)).toEqual(['Telefone']);
  });

  it('o relógio local a recuar não gera hlc repetidos nem decrescentes', () => {
    const w = new World();
    const a = new SimDevice('pca', w);
    const create = a.create(R, { Nome: 'X' });
    w.advance(-5 * MIN);
    const e1 = a.edit(R, { Nome: 'Y' });
    const e2 = a.edit(R, { Nome: 'Z' });
    expect(create.hlc < e1.hlc && e1.hlc < e2.hlc).toBe(true);
    expect(recordValues(stateFromEvents([e2, e1, create]).records[R]).Nome).toBe('Z');
  });
});

describe('merge — ordem de chegada, duplicados, PCs offline', () => {
  function scenario(): RgEvent[] {
    const w = new World();
    const a = new SimDevice('pca', w, 3 * MIN);
    const b = new SimDevice('pcb', w, -7 * MIN);
    const c = new SimDevice('pcc', w, 0);
    const all: RgEvent[] = [];
    const share = (from: SimDevice, to: SimDevice[]) => to.forEach((d) => d.receive(from.known.values()));
    for (let i = 0; i < 4; i++) all.push(a.create(`r${i}`, { Nome: `Fictícia ${i}`, DUM: '2026-02-0' + (i + 1), Estado: 'Ativa' }));
    share(a, [b, c]);
    for (let round = 0; round < 6; round++) {
      w.advance(10_000);
      all.push(a.edit(`r${round % 4}`, { Telefone: `91000000${round}` }));
      all.push(b.edit(`r${(round + 1) % 4}`, { Telefone: `92000000${round}`, Contactada: round % 2 ? 'Sim' : 'Não' }));
      if (round < 3) share(a, [b]);
      // c fica "offline dias" e só edita localmente
      w.advance(86_400_000);
      all.push(c.edit(`r${round % 4}`, { Observacoes: `nota ${round}` }));
      if (round === 4) all.push(c.edit('r2', { Telefone: '930000000' }));
    }
    return all;
  }

  it('qualquer ordem de chegada produz exatamente o mesmo estado', () => {
    const events = scenario();
    const ref = stateFromEvents(events);
    expect(Object.keys(ref.records)).toHaveLength(4);
    for (let seed = 1; seed <= 25; seed++) {
      const st = emptyState();
      for (const e of shuffled(events, seed)) applyEvent(st, e); // sem ordenar: aplicação incremental
      expect(st.records).toEqual(ref.records);
    }
  });

  it('ficheiros duplicados são ignorados (mesmo id)', () => {
    const events = scenario();
    const dup = [...events, ...events.slice(0, 5), ...events.slice(3, 9)];
    const s = stateFromEvents(dup);
    expect(s.duplicates).toBe(11);
    expect(s.records).toEqual(stateFromEvents(events).records);
  });

  it('alteração que chega antes da criação: registo marcado incompleto até a criação chegar', () => {
    const { a, create } = setup();
    const ea = a.edit(R, { Telefone: '911111111' });
    const partial = stateFromEvents([ea]);
    expect(partial.records[R].hasCreate).toBe(false);
    const full = stateFromEvents([ea, create]);
    expect(full.records[R].hasCreate).toBe(true);
    expect(recordValues(full.records[R]).Telefone).toBe('911111111');
  });
});

describe('merge — schemaVersion antiga', () => {
  it('evento sem schemaVersion, hlc nem baseRev é migrado e ordenado pela data', () => {
    const { create } = setup();
    const legacy = normalizeEvent({
      id: 'legacy-1',
      ts: '2026-10-05T10:00:00.000Z',
      author: 'Antigo',
      deviceId: 'pcold',
      recordId: R,
      type: 'update',
      changes: { Telefone: { from: '910000000', to: 919999999 } },
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.migrated).toBe(true);
    const rec = stateFromEvents([create, legacy.value]).records[R];
    expect(recordValues(rec).Telefone).toBe('919999999');
    expect(recordConflicts(rec)).toEqual([]);
  });
});
