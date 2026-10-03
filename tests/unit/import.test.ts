import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { utils, write } from 'xlsx';
import { parseWorkbook, ImportError, nameDumKey } from '../../src/import/excel';
import { DEFAULT_CONFIG } from '../../src/core/types';

const FIXTURE = fileURLToPath(new URL('../fixtures/registo_gravidas_ANONIMIZADO.xlsx', import.meta.url));
const empty = () => ({ sns: new Set<string>(), nameDum: new Set<string>() });

describe('importação do Excel (fixture anonimizado)', () => {
  const buf = readFileSync(FIXTURE);

  it('lê a folha "Grávidas 2026" com cabeçalho na linha 3 e ignora linhas só com fórmula', () => {
    const plan = parseWorkbook(buf, DEFAULT_CONFIG, empty());
    expect(plan.sheetName).toBe('Grávidas 2026');
    expect(plan.headerRow).toBe(3);
    expect(plan.rows).toHaveLength(4);
    expect(plan.rows.map((r) => r.rowNumber)).toEqual([4, 5, 6, 7]);
    expect(plan.emptyRows).toBeGreaterThan(400);
    expect(plan.ignoredColumns).toEqual(expect.arrayContaining(['Semanas de Gravidez', 'Coluna1', 'Curso']));
    expect(plan.counts).toEqual({ novos: 4, duplicados: 0, comAvisos: 0 });
  });

  it('converte datas de série, SNS e telefone numéricos e normaliza escolhas', () => {
    const [a, b, c, d] = parseWorkbook(buf, DEFAULT_CONFIG, empty()).rows.map((r) => r.values);
    expect(a).toMatchObject({
      Nome: 'Maria Exemplo Teste',
      NumeroSNS: '100000001',
      DataNascimento: '1994-04-12',
      Telefone: '910000001',
      UnidadeFuncional: 'USF Parque Cidade',
      MedicoAssistente: 'Dr. Médico Fictício A',
      DUM: '2026-03-07',
      DPP: '2026-12-12',
      ProvenienciaContacto: 'Plataforma',
      Contactada: 'Sim',
      Estado: 'Ativa',
    });
    expect(a.Email).toBeUndefined();
    expect(b).toMatchObject({ Email: 'joana.teste@example.com', ProvenienciaContacto: 'Email', Contactada: 'Não', UnidadeFuncional: 'UCSP Loures' });
    expect(c.Contactada).toBeUndefined(); // vazio no Excel
    expect(c.ProvenienciaContacto).toBe('Telefone');
    // "Unidade de Saude" -> "Unidade de Saúde"; "UCC Loures" está na lista da app
    expect(d).toMatchObject({ ProvenienciaContacto: 'Unidade de Saúde', UnidadeFuncional: 'UCC Loures', Contactada: 'Sim' });
  });

  it('protege contra importação duplicada por SNS', () => {
    const existing = { sns: new Set(['100000001', '100000003']), nameDum: new Set<string>() };
    const plan = parseWorkbook(buf, DEFAULT_CONFIG, existing);
    expect(plan.rows.map((r) => r.status)).toEqual(['duplicado', 'novo', 'duplicado', 'novo']);
    expect(plan.counts.novos).toBe(2);
    expect(plan.counts.duplicados).toBe(2);
  });

  it('assinala valores fora das listas mas importa-os', () => {
    const cfg = { ...DEFAULT_CONFIG, UnidadeFuncional: DEFAULT_CONFIG.UnidadeFuncional.filter((u) => u !== 'UCC Loures') };
    const plan = parseWorkbook(buf, cfg, empty());
    const d = plan.rows[3];
    expect(d.status).toBe('novo');
    expect(d.values.UnidadeFuncional).toBe('UCC Loures');
    expect(d.warnings.join()).toMatch(/fora da lista/);
    expect(d.values.AvisosImportacao).toMatch(/UCC Loures/);
  });
});

function sheetBook(rows: unknown[][], sheetName = 'Grávidas 2026'): Uint8Array {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), sheetName);
  return write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

const HEADER = ['Nome', 'SNS', 'Data Nascimento', 'Email', 'Telefone', 'Unidade Funcional', 'Médico Assistente', 'Semanas de Gravidez', 'DUM ', 'DPP', 'Coluna1', 'Proveniência do contacto', 'Curso', 'contactada'];

describe('importação — casos sintéticos', () => {
  it('calcula DPP quando falta, deteta duplicados dentro do ficheiro e avisos', () => {
    const buf = sheetBook([
      ['REGISTO GRÁVIDAS'],
      [],
      HEADER,
      ['Teste Um', 200000001, null, 'mau-email', 123, 'usf magnolia', null, null, 46100, null, null, 'telefone', null, 'talvez'],
      ['Teste Dois', 200000001, null, null, null, null, null, null, 46100, null, null, null, null, null],
      ['Teste Três', null, null, null, '+351 912 345 678', 'Inexistente', null, null, '15/02/2026', null, null, null, null, 'nao'],
      [null, null, null, null, null, null, null, 12, null, null, null, null, 'Entre ...', null],
    ]);
    const plan = parseWorkbook(buf, DEFAULT_CONFIG, empty());
    expect(plan.rows).toHaveLength(3);
    const [a, b, c] = plan.rows;
    expect(a.values.DPP).toBe('2026-12-24');
    expect(a.values.UnidadeFuncional).toBe('USF Magnolia');
    expect(a.values.ProvenienciaContacto).toBe('Telefone');
    expect(a.warnings.join(' | ')).toMatch(/Email.*inválido.*Telefone.*Contactada/);
    expect(b.status).toBe('duplicado-ficheiro');
    expect(c.values).toMatchObject({ Telefone: '912345678', DUM: '2026-02-15', Contactada: 'Não', UnidadeFuncional: 'Inexistente' });
    expect(plan.emptyRows).toBe(1);
  });

  it('linhas sem SNS: duplicado por nome + DUM', () => {
    const buf = sheetBook([[], [], HEADER, ['Teste Sem SNS', null, null, null, null, null, null, null, 46100]]);
    const existing = { sns: new Set<string>(), nameDum: new Set([nameDumKey('teste sem sns', '2026-03-19')]) };
    expect(parseWorkbook(buf, DEFAULT_CONFIG, existing).rows[0].status).toBe('duplicado');
  });

  it('erro claro se faltar a folha ou o cabeçalho', () => {
    expect(() => parseWorkbook(sheetBook([['x']], 'Outra'), DEFAULT_CONFIG, empty())).toThrow(ImportError);
    expect(() => parseWorkbook(sheetBook([['a', 'b']]), DEFAULT_CONFIG, empty())).toThrow(/cabeçalho/);
    expect(() => parseWorkbook(new Uint8Array([1, 2, 3]), DEFAULT_CONFIG, empty())).toThrow(ImportError);
  });
});
