import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cleanup, FIXTURE_XLSX, firstUse, listFiles, makeFolder, openApp, readJson } from './helpers';

let folder: string;
test.beforeEach(() => {
  folder = makeFolder();
});
test.afterEach(() => cleanup(folder));

test('modo completo: primeira utilização, validação, criar, editar, histórico e ficheiros em disco', async ({ context }) => {
  const page = await openApp(context, folder, 'full');
  await firstUse(page, 'Ana Teste');
  await page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
  await expect(page.getByTestId('mode')).toHaveText('Modo completo');
  await expect(page.getByTestId('last-update')).not.toHaveText('—');
  expect(listFiles(folder, 'data').filter((f) => f.includes('.probe'))).toEqual([]);

  await page.getByRole('link', { name: 'Nova grávida' }).click();
  await page.getByRole('button', { name: 'Criar registo' }).click();
  const summary = page.getByTestId('form-summary');
  await expect(summary).toContainText('O nome é obrigatório');
  await expect(summary).toContainText('A DUM é obrigatória');
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveAttribute('aria-invalid', 'true');

  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Maria Fictícia E2E');
  await page.getByLabel('N.º SNS').fill('123456789');
  await page.getByLabel('Telefone').fill('912 345 678');
  await page.getByLabel('Telefone').press('Tab');
  await page.getByRole('textbox', { name: 'DUM', exact: true }).fill('07/03/2026');
  await expect(page.getByLabel('DPP', { exact: true })).toHaveValue('12/12/2026');
  await expect(page.getByTestId('ga')).toHaveText('30s 0d');
  await expect(page.getByTestId('course')).toHaveText('19/09/2026 a 17/10/2026');
  await page.getByLabel('Unidade funcional').selectOption('USF Magnolia');
  await page.getByLabel('Email').fill('invalido@');
  await page.getByRole('button', { name: 'Criar registo' }).click();
  await expect(summary).toContainText('Email inválido');
  // erro de validação: nada foi gravado e o formulário mantém os dados
  expect(listFiles(folder, 'data/events')).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Maria Fictícia E2E');
  await page.getByLabel('Email').fill('maria@example.com');
  await page.getByRole('button', { name: 'Criar registo' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Maria Fictícia E2E' })).toBeVisible();
  const files = listFiles(folder, 'data/events');
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^data\/events\/2026\/10\/2026-10-03T09-\d{2}-\d{2}-\d{3}Z_pc[a-z0-9]+_[0-9a-f-]{36}\.json$/);
  const ev = readJson(folder, files[0]) as Record<string, any>;
  expect(ev).toMatchObject({ schemaVersion: 1, type: 'create', author: 'Ana Teste', baseRev: null });
  expect(ev.changes.Telefone).toEqual({ from: null, to: '912345678' });
  expect(ev.changes.DPP).toEqual({ from: null, to: '2026-12-12' });
  expect(ev.changes.Estado).toEqual({ from: null, to: 'Ativa' });

  // editar
  await page.getByLabel('Telefone').fill('913333333');
  await page.getByLabel('Contactada', { exact: true }).selectOption('Sim');
  await page.getByRole('button', { name: 'Guardar alterações' }).click();
  await expect(page.locator('.history tbody tr').first()).toContainText('913333333');
  await expect(page.locator('.history')).toContainText('912345678');
  expect(listFiles(folder, 'data/events')).toHaveLength(2);
  const upd = readJson(folder, listFiles(folder, 'data/events').find((f) => f !== files[0])!) as Record<string, any>;
  expect(upd.type).toBe('update');
  expect(upd.baseRev).toBe(ev.hlc);
  expect(Object.keys(upd.changes).sort()).toEqual(['Contactada', 'Telefone']);

  // arquivar em vez de apagar
  await page.getByRole('button', { name: 'Arquivar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Arquivar' }).click();
  await expect(page.getByText('Este registo está arquivado')).toBeVisible();
  await page.getByRole('link', { name: 'Registos', exact: true }).click();
  await expect(page.getByTestId('result-count')).toHaveText('0 registos de 1');
  await page.getByLabel('Estado', { exact: true }).selectOption('*');
  await expect(page.getByRole('link', { name: 'Maria Fictícia E2E' })).toBeVisible();
  expect(listFiles(folder, 'data/events')).toHaveLength(3);

  // diagnóstico
  await page.getByRole('link', { name: 'Diagnóstico' }).click();
  const diag = page.getByTestId('diag-table');
  await expect(diag).toContainText('Modo ativocompleto');
  await expect(diag).toContainText('Teste de escrita (data/.probe)OK');
  await expect(diag).toContainText('Ficheiros de eventos lidos3');
});

test('modo completo: importar Excel, duplicados, A contactar, CSV e consolidar', async ({ context }) => {
  const page = await openApp(context, folder, 'full', new Date('2026-10-20T10:00:00+01:00'));
  await firstUse(page, 'Importadora');
  await page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
  await page.getByRole('link', { name: 'Importar Excel' }).click();
  await page.getByLabel('Ficheiro Excel (.xlsx)').setInputFiles(FIXTURE_XLSX);
  await expect(page.getByTestId('count-new')).toHaveText('4');
  await expect(page.getByTestId('count-dup')).toHaveText('0');
  await expect(page.getByTestId('import-summary')).toContainText('cabeçalho na linha 3');
  await page.getByRole('button', { name: 'Importar 4 registos novos' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Importar' }).click();
  await expect(page.getByText('Importação concluída: 4 registos criados.')).toBeVisible();
  expect(listFiles(folder, 'data/events')).toHaveLength(4);

  // proteção contra importação duplicada
  await page.getByLabel('Ficheiro Excel (.xlsx)').setInputFiles([]);
  await page.getByLabel('Ficheiro Excel (.xlsx)').setInputFiles(FIXTURE_XLSX);
  await expect(page.getByTestId('count-new')).toHaveText('0');
  await expect(page.getByTestId('count-dup')).toHaveText('4');

  await page.getByRole('link', { name: 'Registos', exact: true }).click();
  await expect(page.getByTestId('result-count')).toHaveText('4 registos de 4');
  const rita = page.getByRole('row', { name: /Rita Demo Pereira/ });
  await expect(rita).toContainText('UCC Loures');
  await expect(rita).toContainText('14/02/2026');
  await page.getByLabel('Pesquisar').fill('joana');
  await expect(page.getByTestId('result-count')).toHaveText('1 registo de 4');
  await page.getByLabel('Pesquisar').fill('');
  await page.getByLabel('Curso começa nas próximas').fill('4');
  await expect(page.getByTestId('result-count')).toHaveText('1 registo de 4');
  await page.getByLabel('Curso começa nas próximas').fill('');

  // ordenação acessível
  await page.getByRole('button', { name: 'DUM' }).click();
  await expect(page.getByRole('columnheader', { name: 'DUM' })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('table.data tbody tr').first()).toContainText('Rita Demo Pereira');

  // CSV
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar vista para CSV' }).click();
  const csvPath = await (await dl).path();
  const csv = readFileSync(csvPath!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('Nome;N.º SNS;Data de nascimento');
  expect(csv).toContain('Maria Exemplo Teste;100000001;12/04/1994');
  expect(csv.trim().split('\r\n')).toHaveLength(5);

  // A contactar: Joana (DUM 02/05/2026, não contactada) — janela começa a 14/11/2026
  await page.getByRole('link', { name: 'A contactar' }).click();
  await expect(page.getByRole('heading', { name: /começa nas próximas 4 semanas \(1\)/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Joana Ficção Silva/ })).toContainText('14/11/2026 – 12/12/2026');
  await page.getByRole('button', { name: 'Marcar Joana Ficção Silva como contactada' }).click();
  await expect(page.getByRole('heading', { name: /começa nas próximas 4 semanas \(0\)/ })).toBeVisible();

  // consolidar
  await page.getByRole('link', { name: 'Consolidar' }).click();
  await page.getByRole('button', { name: 'Consolidar agora' }).click();
  await expect(page.getByText(/Snapshot gravado \(5 eventos incluídos\)/)).toBeVisible();
  const snaps = listFiles(folder, 'data/snapshots');
  expect(snaps).toHaveLength(1);
  expect(snaps[0]).toMatch(/^data\/snapshots\/snapshot_2026-10-20T09-\d{2}-\d{2}-\d{3}Z_pc[a-z0-9]+\.json$/);
  expect((readJson(folder, snaps[0]) as { eventIds: string[] }).eventIds).toHaveLength(5);

  // nova sessão (recarregar): estado vem do snapshot; a pasta é pedida de novo
  // (o handle simulado não sobrevive ao IndexedDB — testa a degradação)
  await page.reload();
  await expect(page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' })).toBeVisible();
  await page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
  await page.getByRole('link', { name: 'Registos', exact: true }).click();
  await expect(page.getByTestId('result-count')).toHaveText('4 registos de 4');
  await page.getByRole('link', { name: 'Diagnóstico' }).click();
  await expect(page.getByTestId('diag-table')).toContainText('Pasta guardada entre sessõesnão (será pedida em cada sessão)');
  await expect(page.getByTestId('diag-table')).toContainText('Snapshots1');
});

test('dois PCs em modo completo: conflito no mesmo campo e resolução', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openApp(ctxA, folder, 'full');
  const b = await openApp(ctxB, folder, 'full');
  for (const [p, n] of [[a, 'Ana'], [b, 'Bruno']] as const) {
    await firstUse(p, n);
    await p.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
    await expect(p.getByTestId('mode')).toHaveText('Modo completo');
  }
  await a.getByRole('link', { name: 'Nova grávida' }).click();
  await a.getByRole('textbox', { name: 'Nome', exact: true }).fill('Conflito Fictícia');
  await a.getByRole('textbox', { name: 'DUM', exact: true }).fill('01/04/2026');
  await a.getByRole('button', { name: 'Criar registo' }).click();
  await expect(a.getByRole('heading', { level: 2, name: 'Conflito Fictícia' })).toBeVisible();

  await b.getByRole('button', { name: 'Atualizar' }).click();
  await b.getByRole('link', { name: 'Conflito Fictícia' }).click();
  // ambos alteram o telefone sem verem a alteração do outro
  await a.getByLabel('Telefone').fill('911111111');
  await b.getByLabel('Telefone').fill('922222222');
  await a.getByRole('button', { name: 'Guardar alterações' }).click();
  await expect(a.locator('.history')).toContainText('911111111');
  await b.getByRole('button', { name: 'Guardar alterações' }).click();
  await expect(b.locator('.history')).toContainText('922222222');

  await a.getByRole('button', { name: 'Atualizar' }).click();
  const panel = a.getByTestId('conflict-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('911111111');
  await expect(panel).toContainText('922222222');
  await expect(panel).toContainText('Bruno');
  await panel.getByLabel(/922222222/).check();
  await panel.getByRole('button', { name: 'Resolver conflito' }).click();
  await expect(a.getByTestId('conflict-panel')).toHaveCount(0);
  await expect(a.getByLabel('Telefone')).toHaveValue('922222222');
  await expect(a.locator('.history')).toContainText('Resolução de conflito');

  await b.getByRole('button', { name: 'Atualizar' }).click();
  await expect(b.getByTestId('conflict-panel')).toHaveCount(0);
  await ctxA.close();
  await ctxB.close();
});
