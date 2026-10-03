import { expect, test } from '@playwright/test';
import { eventRelPath, makeEvent, serializeEvent } from '../../src/core/events';
import { formatHlc } from '../../src/core/hlc';
import { cleanup, FIXTURE_XLSX, firstUse, listFiles, makeFolder, openApp, pickCompatFolder, readJson, saveDownloadTo, writeRaw } from './helpers';

let folder: string;
test.beforeEach(() => {
  folder = makeFolder();
});
test.afterEach(() => cleanup(folder));

function seedEvent(): string {
  const ms = Date.UTC(2026, 9, 1, 8);
  const ev = makeEvent({
    hlc: formatHlc({ ms, c: 0 }),
    author: 'Colega Fictícia',
    deviceId: 'pcseed',
    recordId: 'seed-1',
    type: 'create',
    changes: { Nome: { from: null, to: 'Grávida Semente' }, DUM: { from: null, to: '2026-05-01' }, Estado: { from: null, to: 'Ativa' } },
    baseRev: null,
    now: new Date(ms),
  });
  writeRaw(folder, eventRelPath(ev), serializeEvent(ev));
  return ev.id;
}

test('modo compatível: ler pasta, gravar por descarga, fila pendente e confirmação', async ({ context }) => {
  seedEvent();
  // ficheiros a ignorar, com motivo no Diagnóstico
  writeRaw(folder, 'data/events/2026/10/a-meio.json', '{"schemaVersion":1,"id":"x"');
  writeRaw(folder, 'data/events/2026/10/qualquer.json.crswap', '{}');
  const page = await openApp(context, folder, 'compat');
  await firstUse(page, 'Rui Compatível');
  await expect(page.getByText('O acesso direto a pastas não está disponível neste browser')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' })).toHaveCount(0);
  await pickCompatFolder(page, folder, () => page.getByRole('button', { name: 'Selecionar pasta (modo compatível)' }).click());
  await expect(page.getByTestId('mode')).toHaveText('Modo compatível');
  await expect(page.getByRole('link', { name: 'Grávida Semente' })).toBeVisible();

  // criar → descarga com o nome correto + instruções com o caminho exato
  await page.getByRole('link', { name: 'Nova grávida' }).click();
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Compatível Fictícia');
  await page.getByRole('textbox', { name: 'DUM', exact: true }).fill('15/03/2026');
  const dlP = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Criar registo' }).click();
  const dl = await dlP;
  expect(dl.suggestedFilename()).toMatch(/^2026-10-03T09-\d{2}-\d{2}-\d{3}Z_pc[a-z0-9]+_[0-9a-f-]{36}\.json$/);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Ficheiro descarregado');
  await expect(dialog.getByTestId('target-path')).toHaveText('RegistoGravidas\\data\\events\\2026\\10\\');
  await dialog.getByRole('button', { name: 'Percebi' }).click();
  // visível localmente, marcado "Por confirmar"
  await expect(page.getByRole('heading', { level: 2, name: 'Compatível Fictícia' })).toBeVisible();
  await expect(page.locator('.history')).toContainText('Por confirmar');
  await expect(page.getByTestId('pending-banner')).toContainText('1 alteração ainda não confirmada');

  // "Atualizar" sem mover o ficheiro: continua pendente (aviso mantém-se)
  await pickCompatFolder(page, folder, () => page.getByRole('button', { name: 'Atualizar' }).click());
  await expect(page.getByTestId('pending-banner')).toBeVisible();

  // o utilizador move o ficheiro para a pasta indicada e atualiza
  const saved = await saveDownloadTo(folder, dl, 'data/events/2026/10');
  expect((readJson(folder, saved) as { author: string }).author).toBe('Rui Compatível');
  await pickCompatFolder(page, folder, () => page.getByRole('button', { name: 'Atualizar' }).click());
  await expect(page.getByTestId('pending-banner')).toHaveCount(0);
  await expect(page.locator('.history')).not.toContainText('Por confirmar');

  // diagnóstico
  await page.getByRole('link', { name: 'Diagnóstico' }).click();
  const diag = page.getByTestId('diag-table');
  await expect(diag).toContainText('window.showDirectoryPickerausente');
  await expect(diag).toContainText('Modo ativocompatível (leitura por seleção da pasta)');
  await expect(diag).toContainText('Ficheiros de eventos lidos2');
  await expect(page.getByRole('row', { name: /a-meio\.json/ })).toContainText('JSON inválido ou incompleto');
  await expect(page.getByRole('row', { name: /\.crswap/ })).toContainText('crswap');
});

test('modo compatível: importação gera um ZIP; pendentes sobrevivem a recarregar', async ({ context }) => {
  const page = await openApp(context, folder, 'compat', new Date('2026-10-20T10:00:00+01:00'));
  await firstUse(page, 'Rui');
  await pickCompatFolder(page, folder, () => page.getByRole('button', { name: 'Selecionar pasta (modo compatível)' }).click());
  await page.getByRole('link', { name: 'Importar Excel' }).click();
  await page.getByLabel('Ficheiro Excel (.xlsx)').setInputFiles(FIXTURE_XLSX);
  await expect(page.getByTestId('count-new')).toHaveText('4');
  await page.getByRole('button', { name: 'Importar 4 registos novos' }).click();
  const dlP = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Importar' }).click();
  const dl = await dlP;
  expect(dl.suggestedFilename()).toMatch(/^eventos_.*\.zip$/);
  await expect(page.getByRole('dialog')).toContainText('Extrair tudo');
  await page.getByRole('dialog').getByRole('button', { name: 'Percebi' }).click();

  await page.reload();
  await pickCompatFolder(page, folder, () => page.getByRole('button', { name: 'Selecionar pasta (modo compatível)' }).click());
  await expect(page.getByTestId('pending-banner')).toContainText('4 alterações ainda não confirmadas');
  await page.getByRole('link', { name: 'Registos', exact: true }).click();
  await expect(page.getByTestId('result-count')).toHaveText('4 registos de 4');
  // proteção contra duplicados conta também com os pendentes
  await page.getByRole('link', { name: 'Importar Excel' }).click();
  await page.getByLabel('Ficheiro Excel (.xlsx)').setInputFiles(FIXTURE_XLSX);
  await expect(page.getByTestId('count-dup')).toHaveText('4');
});

test('API presente mas escrita recusada → modo compatível automático (leitura pelo handle)', async ({ context }) => {
  seedEvent();
  const page = await openApp(context, folder, 'full-readonly');
  await firstUse(page, 'Leitora');
  await page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
  await expect(page.getByTestId('mode')).toHaveText('Modo compatível');
  await expect(page.getByText('Não é possível gravar diretamente na pasta')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Grávida Semente' })).toBeVisible();
  await page.getByRole('link', { name: 'Grávida Semente' }).click();
  await page.getByLabel('Telefone').fill('912000000');
  const dlP = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Guardar alterações' }).click();
  await dlP;
  await expect(page.getByRole('dialog')).toContainText('RegistoGravidas\\data\\events\\2026\\10\\');
  expect(listFiles(folder, 'data/events')).toHaveLength(1); // nada escrito na pasta
});

test('os dois modos coexistem na mesma pasta', async ({ browser }) => {
  const ctxFull = await browser.newContext();
  const ctxCompat = await browser.newContext();
  const full = await openApp(ctxFull, folder, 'full');
  await firstUse(full, 'Ana Completo');
  await full.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
  await full.getByRole('link', { name: 'Nova grávida' }).click();
  await full.getByRole('textbox', { name: 'Nome', exact: true }).fill('Partilhada Fictícia');
  await full.getByRole('textbox', { name: 'DUM', exact: true }).fill('10/04/2026');
  await full.getByRole('button', { name: 'Criar registo' }).click();
  await expect(full.getByRole('heading', { level: 2, name: 'Partilhada Fictícia' })).toBeVisible();

  const compat = await openApp(ctxCompat, folder, 'compat');
  await firstUse(compat, 'Rui Compatível');
  await pickCompatFolder(compat, folder, () => compat.getByRole('button', { name: 'Selecionar pasta (modo compatível)' }).click());
  await compat.getByRole('link', { name: 'Partilhada Fictícia' }).click();
  await compat.getByLabel('Contactada', { exact: true }).selectOption('Sim');
  const dlP = compat.waitForEvent('download', { timeout: 10_000 });
  await compat.getByRole('button', { name: 'Guardar alterações' }).click();
  // Se a descarga não acontecer, mostra o estado da página para diagnóstico.
  const dlx = await dlP.catch(async (e) => {
    throw new Error(`descarga não ocorreu: ${e}\n--- página ---\n${await compat.locator('main').innerText()}`);
  });
  await saveDownloadTo(folder, dlx, 'data/events'); // diretamente em data\events também serve

  await full.getByRole('button', { name: 'Atualizar' }).click();
  await expect(full.getByLabel('Contactada', { exact: true })).toHaveValue('Sim');
  await expect(full.locator('.history')).toContainText('Rui Compatível');
  await ctxFull.close();
  await ctxCompat.close();
});
