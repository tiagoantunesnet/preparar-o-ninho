import { describe, expect, it } from 'vitest';
import { eventFileName, eventRelPath, makeEvent, normalizeEvent, parseEventText, serializeEvent } from '../../src/core/events';
import { HlcClock, formatHlc, hlcPredecessor, parseHlc } from '../../src/core/hlc';
import { newDeviceId, uuid, UUID_RE } from '../../src/core/ids';
import { ignoreReason } from '../../src/core/fileFilter';

const base = () =>
  makeEvent({
    hlc: formatHlc({ ms: Date.UTC(2026, 9, 3, 12, 0, 0), c: 0 }),
    author: 'Teste',
    deviceId: 'pcabc',
    recordId: 'r1',
    type: 'create',
    changes: { Nome: { from: null, to: 'Fictícia' } },
    baseRev: null,
    now: new Date('2026-10-03T12:34:56.789Z'),
  });

describe('formato dos eventos', () => {
  it('nome de ficheiro <ISO-UTC>_<deviceId>_<uuid>.json sem ":" (válido no Windows) e pasta AAAA/MM', () => {
    const ev = base();
    expect(eventFileName(ev)).toBe(`2026-10-03T12-34-56-789Z_pcabc_${ev.id}.json`);
    expect(eventRelPath(ev)).toBe(`data/events/2026/10/2026-10-03T12-34-56-789Z_pcabc_${ev.id}.json`);
    expect(eventFileName(ev)).not.toMatch(/[:<>"|?*\\]/);
  });

  it('serializa e volta a ler sem alterações', () => {
    const ev = base();
    const r = parseEventText(serializeEvent(ev));
    expect(r).toEqual({ ok: true, value: ev, migrated: false });
  });

  it('ficheiro corrompido ou a meio da sincronização é rejeitado com motivo', () => {
    const t = serializeEvent(base());
    const r1 = parseEventText(t.slice(0, 40));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/incompleto/);
    expect(parseEventText('').ok).toBe(false);
    expect(parseEventText('[]').ok).toBe(false);
    expect(parseEventText('{"id":"x"}').ok).toBe(false);
    expect(parseEventText(JSON.stringify({ ...base(), type: 'delete' })).ok).toBe(false);
  });

  it('schemaVersion mais recente é recusada; antiga é migrada', () => {
    const r = normalizeEvent({ ...base(), schemaVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/versão mais recente/);
    const old = { ...base() } as Record<string, unknown>;
    delete old.schemaVersion;
    delete old.hlc;
    const m = normalizeEvent(old);
    expect(m.ok && m.migrated).toBe(true);
    if (m.ok) expect(parseHlc(m.value.hlc)!.ms).toBe(Date.parse('2026-10-03T12:34:56.789Z'));
  });

  it('valores não-texto são convertidos; chaves perigosas descartadas; baseRev >= hlc corrigido', () => {
    const raw = JSON.parse(serializeEvent({ ...base(), type: 'update', baseRev: base().hlc }));
    raw.changes = JSON.parse('{"Telefone":{"from":null,"to":912345678},"__proto__":{"from":null,"to":"x"},"Bad":{"to":{}}}');
    const r = normalizeEvent(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changes).toEqual({ Telefone: { from: null, to: '912345678' } });
    expect(r.value.baseRev! < r.value.hlc).toBe(true);
  });
});

describe('hlc', () => {
  it('monotónico mesmo com o relógio a recuar e após observar valores remotos', () => {
    let t = 1_000_000;
    const c = new HlcClock(() => t);
    const a = c.tick();
    t -= 50_000;
    const b = c.tick();
    c.observe(formatHlc({ ms: 9_000_000, c: 5 }));
    const d = c.tick();
    expect(a < b && b < d).toBe(true);
    expect(parseHlc(d)).toEqual({ ms: 9_000_000, c: 6 });
    expect(hlcPredecessor(formatHlc({ ms: 10, c: 0 }))).toBe(formatHlc({ ms: 9, c: 999_999 }));
  });

  it('comparação de texto coincide com a ordem numérica', () => {
    expect(formatHlc({ ms: 9, c: 1 }) < formatHlc({ ms: 10, c: 0 })).toBe(true);
    expect(formatHlc({ ms: 10, c: 2 }) < formatHlc({ ms: 10, c: 10 })).toBe(true);
  });
});

describe('ids e filtro de ficheiros', () => {
  it('uuid v4 e deviceId seguro para nomes de ficheiro', () => {
    expect(uuid()).toMatch(UUID_RE);
    expect(newDeviceId()).toMatch(/^pc[a-z0-9]{10}$/);
  });

  it('ignora temporários do browser/OneDrive e não-JSON', () => {
    expect(ignoreReason('x.json.crswap')).toMatch(/crswap/);
    expect(ignoreReason('abc.tmp')).toMatch(/tmp/);
    expect(ignoreReason('~$registo.json')).toBeTruthy();
    expect(ignoreReason('.849C9593-D756-4E56-8D6E-42412F2A707B')).toBeTruthy();
    expect(ignoreReason('desktop.ini')).toBeTruthy();
    expect(ignoreReason('notas.txt')).toBeTruthy();
    expect(ignoreReason('evento.json.crdownload')).toBeTruthy();
    expect(ignoreReason('evento.json', 0)).toMatch(/vazio/);
    expect(ignoreReason('2026-10-03T12-34-56-789Z_pc_x-DESKTOP-ABC.json', 10)).toBeNull();
  });
});
