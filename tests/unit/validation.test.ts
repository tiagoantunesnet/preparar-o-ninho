import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/core/csv';
import { applyFilters, buildViews, DEFAULT_FILTERS, sortViews, toContact } from '../../src/core/records';
import { stateFromEvents } from '../../src/core/merge';
import { DEFAULT_CONFIG } from '../../src/core/types';
import { canonicalChoice, normalizePhone, validateRecord } from '../../src/core/validation';
import { crc32, makeZip } from '../../src/core/zip';
import { SimDevice, World } from '../helpers/devices';

const ctx = (sns: Record<string, string[]> = {}) => ({ config: DEFAULT_CONFIG, today: '2026-10-03', snsIndex: new Map(Object.entries(sns)), recordId: 'r1' });

describe('validação do formulário', () => {
  it('obrigatórios e formatos', () => {
    const { errors } = validateRecord({ NumeroSNS: '12345', Telefone: '12345', Email: 'x@', DUM: '' }, ctx());
    expect(Object.keys(errors).sort()).toEqual(['DUM', 'Email', 'Nome', 'NumeroSNS', 'Telefone']);
  });

  it('registo válido; SNS duplicado é aviso (não erro)', () => {
    const v = { Nome: 'Fictícia', NumeroSNS: '123456789', Telefone: '912345678', Email: 'a@example.com', DUM: '2026-03-07', DPP: '2026-12-12', Contactada: 'Sim', Estado: 'Ativa' };
    expect(validateRecord(v, ctx())).toEqual({ errors: {}, warnings: {} });
    const r = validateRecord(v, ctx({ '123456789': ['r1', 'r2'] }));
    expect(r.errors).toEqual({});
    expect(r.warnings.NumeroSNS).toMatch(/Já existe/);
    expect(validateRecord(v, ctx({ '123456789': ['r1'] })).warnings).toEqual({});
  });

  it('DUM no futuro e DPP antes da DUM são erros', () => {
    const r = validateRecord({ Nome: 'X', DUM: '2026-11-01', DPP: '2026-10-01' }, ctx());
    expect(r.errors.DUM).toBeTruthy();
    expect(r.errors.DPP).toBeTruthy();
  });

  it('normalização de telefone e escolhas', () => {
    expect(normalizePhone('+351 912 345 678')).toBe('912345678');
    expect(normalizePhone('00351912345678')).toBe('912345678');
    expect(canonicalChoice('unidade de saude', DEFAULT_CONFIG.ProvenienciaContacto)).toBe('Unidade de Saúde');
    expect(canonicalChoice('USF ARS MEDICA', DEFAULT_CONFIG.UnidadeFuncional)).toBe('USF Ars médica');
    expect(canonicalChoice('Outra', DEFAULT_CONFIG.UnidadeFuncional)).toBeNull();
  });

  it('static/config.json coincide com as listas por omissão', () => {
    const cfg = JSON.parse(readFileSync(new URL('../../static/config.json', import.meta.url), 'utf8'));
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});

describe('vistas: filtros, ordenação, "A contactar"', () => {
  const w = new World();
  const d = new SimDevice('pca', w);
  const evs = [
    d.create('a', { Nome: 'Ana Fictícia', NumeroSNS: '100000001', DUM: '2026-03-07', UnidadeFuncional: 'UCSP Loures', Contactada: 'Não', Estado: 'Ativa' }),
    d.create('b', { Nome: 'Beatriz Teste', NumeroSNS: '100000002', DUM: '2026-03-15', UnidadeFuncional: 'USF Magnolia', Estado: 'Ativa' }),
    d.create('c', { Nome: 'Carla Exemplo', NumeroSNS: '100000003', DUM: '2026-05-01', Contactada: 'Sim', Estado: 'Ativa' }),
    d.create('e', { Nome: 'Élia Arquivada', NumeroSNS: '100000001', DUM: '2026-03-15', Estado: 'Arquivada' }),
  ];
  const views = buildViews(stateFromEvents(evs), '2026-09-01');

  it('pesquisa por nome (sem acentos) e por SNS; arquivadas escondidas por omissão', () => {
    expect(applyFilters(views, { ...DEFAULT_FILTERS, q: 'beatriz' }, '2026-09-01').map((v) => v.id)).toEqual(['b']);
    expect(applyFilters(views, { ...DEFAULT_FILTERS, q: '100000003' }, '2026-09-01').map((v) => v.id)).toEqual(['c']);
    expect(applyFilters(views, { ...DEFAULT_FILTERS, q: 'elia' }, '2026-09-01')).toHaveLength(0);
    expect(applyFilters(views, { ...DEFAULT_FILTERS, q: 'elia', estado: '*' }, '2026-09-01')).toHaveLength(1);
  });

  it('filtro "janela do curso nas próximas N semanas" e contactada', () => {
    const r = applyFilters(views, { ...DEFAULT_FILTERS, cursoSemanas: 4 }, '2026-09-01').map((v) => v.id).sort();
    expect(r).toEqual(['a', 'b']);
    expect(applyFilters(views, { ...DEFAULT_FILTERS, contactada: 'Não' }, '2026-09-01').map((v) => v.id).sort()).toEqual(['a', 'b']);
  });

  it('SNS repetido assinalado só entre registos não arquivados', () => {
    expect(views.find((v) => v.id === 'a')!.duplicateSNS).toBe(false);
  });

  it('ordenação por DUM e vazios no fim', () => {
    expect(sortViews(views, 'DUM', 'desc').map((v) => v.id)).toEqual(['c', 'b', 'e', 'a']);
    expect(sortViews(views, 'Contactada', 'asc').map((v) => v.id).slice(-2)).toEqual(['b', 'e'].sort());
  });

  it('"A contactar": não contactadas cuja janela começa nas próximas 4 semanas', () => {
    const t = toContact(views, '2026-09-01');
    expect(t.upcoming.map((v) => v.id)).toEqual(['a', 'b']);
    const t2 = toContact(views, '2026-09-25');
    expect(t2.upcoming.map((v) => v.id)).toEqual(['b']);
    expect(t2.inProgress.map((v) => v.id)).toEqual(['a']);
  });
});

describe('CSV e ZIP', () => {
  it('CSV com ";", BOM, aspas e proteção contra fórmulas', () => {
    const csv = toCsv(['Nome', 'Obs'], [['Ana; Silva', '=HYPERLINK("x")'], ['Rita "R"', '-2']]);
    expect(csv.startsWith('﻿Nome;Obs\r\n')).toBe(true);
    expect(csv).toContain('"Ana; Silva";"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"Rita ""R""";\'-2');
  });

  it('ZIP "stored" válido (assinaturas e CRC32)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = makeZip([{ path: '2026/10/a.json', data: new TextEncoder().encode('{}') }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 22 + 10, true)).toBe(1);
  });
});
