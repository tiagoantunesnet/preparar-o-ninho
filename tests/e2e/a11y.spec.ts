import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, FIXTURE_XLSX, firstUse, makeFolder, openApp } from './helpers';

let folder: string;
test.beforeEach(() => {
  folder = makeFolder();
});
test.afterEach(() => cleanup(folder));

async function audit(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = r.violations.map((v) => `${label}: ${v.id} — ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  expect(summary, summary.join('\n')).toEqual([]);
}

test('acessibilidade (WCAG 2.1 A/AA) dos ecrãs principais', async ({ context }) => {
  const page = await openApp(context, folder, 'full');
  await audit(page, 'primeira utilização');
  await firstUse(page, 'Ana');
  await audit(page, 'escolher pasta');
  await page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).click();
  await page.getByRole('link', { name: 'Importar Excel' }).click();
  await page.getByLabel('Ficheiro Excel (.xlsx)').setInputFiles(FIXTURE_XLSX);
  await expect(page.getByTestId('count-new')).toHaveText('4');
  await audit(page, 'pré-visualização da importação');
  await page.getByRole('button', { name: 'Importar 4 registos novos' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Importar' }).click();
  await expect(page.getByText('Importação concluída')).toBeVisible();
  await page.getByRole('link', { name: 'Registos', exact: true }).click();
  await expect(page.getByTestId('result-count')).toHaveText('4 registos de 4');
  await audit(page, 'registos');
  await page.getByRole('link', { name: 'Maria Exemplo Teste' }).click();
  await audit(page, 'ficha');
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('');
  await page.getByRole('button', { name: 'Guardar alterações' }).click();
  await expect(page.getByTestId('form-summary')).toContainText('O nome é obrigatório');
  await audit(page, 'ficha com erros');
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Maria Exemplo Teste');
  for (const nav of ['A contactar', 'Alterações recentes', 'Consolidar', 'Diagnóstico']) {
    await page.getByRole('link', { name: nav }).click();
    await expect(page.getByRole('heading', { level: 2, name: nav })).toBeVisible();
    await audit(page, nav);
  }
});

test('navegação só com teclado: saltar para o conteúdo e foco estável no Atualizar', async ({ context }) => {
  const page = await openApp(context, folder, 'full');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Saltar para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('O seu nome')).toBeFocused();
  await page.keyboard.type('Ana');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Escolher pasta RegistoGravidas' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('mode')).toHaveText('Modo completo');
  // o foco não se perde com as leituras periódicas
  await page.getByRole('button', { name: 'Atualizar' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('last-update')).not.toHaveText('a ler a pasta…');
  await expect(page.getByRole('button', { name: 'Atualizar' })).toBeFocused();
});
