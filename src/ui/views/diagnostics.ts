import { APP_VERSION } from '../../app/controller';
import { formatPtDateTime } from '../../core/dates';
import { SCHEMA_VERSION } from '../../core/types';
import type { UI, View } from '../app';
import { h, replace } from '../dom';

export function diagnosticsView(ui: UI, main: HTMLElement): View {
  const c = ui.ctl;
  const body = h('div');

  const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? 'não testado' : b ? 'sim' : 'não');

  function rows(): [string, string][] {
    const s = c.scan;
    const conflicts = c.views.filter((v) => v.conflicts.length).length;
    return [
      ['Versão da aplicação', `${APP_VERSION} (formato de dados v${SCHEMA_VERSION})`],
      ['Browser', c.caps.browser],
      ['User agent', c.caps.userAgent],
      ['Protocolo', c.caps.protocol],
      ['Contexto seguro', yesNo(c.caps.secureContext)],
      ['window.showDirectoryPicker', c.caps.directoryPicker ? 'disponível' : 'ausente'],
      ['Erro do seletor de pastas', c.pickerError ?? '—'],
      ['<input webkitdirectory>', c.caps.webkitdirectory ? 'disponível' : 'ausente'],
      ['IndexedDB em file://', yesNo(c.caps.indexedDB)],
      ['localStorage', yesNo(c.caps.localStorage)],
      ['Pasta guardada entre sessões', c.handlePersisted === null ? '—' : c.handlePersisted ? 'sim' : 'não (será pedida em cada sessão)'],
      ['Teste de escrita (data/.probe)', c.probe ? (c.probe.ok ? 'OK' : `falhou: ${c.probe.error ?? ''}`) : 'não testado'],
      ['Modo ativo', c.mode === 'full' ? 'completo' : c.mode === 'compat' ? `compatível (${c.compat?.kind === 'handle' ? 'leitura pelo handle' : 'leitura por seleção da pasta'})` : 'sem pasta'],
      ['Pasta', c.folderName || '—'],
      ['Atualização automática', c.canAutoRefresh ? 'a cada 20 s e ao voltar à janela' : 'manual (botão "Atualizar")'],
      ['Identificador deste PC (deviceId)', c.deviceId],
      ['Última leitura', s ? formatPtDateTime(s.at.toISOString(), true) : '—'],
      ['Erro na última leitura', c.scanError ?? '—'],
      ['Ficheiros de eventos lidos', String(s?.eventFiles ?? 0)],
      ['Eventos únicos', String(s?.events.length ?? 0)],
      ['Ficheiros duplicados', String(s?.duplicateFiles ?? 0)],
      ['Eventos de versão antiga (migrados)', String(s?.migratedEvents ?? 0)],
      ['Lidos de novo nesta leitura', String(s?.newlyRead ?? 0)],
      ['Snapshots', String(s?.snapshots.length ?? 0)],
      ['config.json', s ? (s.configFound ? (s.configError ? `erro: ${s.configError}` : 'OK') : 'não encontrado (listas por omissão)') : '—'],
      ['Registos', String(c.views.length)],
      ['Registos com conflito', String(conflicts)],
      ['Pendentes de confirmação', String(c.pending.list().length)],
      ['Ficheiros ignorados', String(s?.ignored.length ?? 0)],
    ];
  }

  function asText(): string {
    const lines = rows().map(([k, v]) => `${k}: ${v}`);
    for (const i of c.scan?.ignored ?? []) lines.push(`IGNORADO ${i.path} — ${i.reason}`);
    return lines.join('\n');
  }

  function render() {
    const ignored = c.scan?.ignored ?? [];
    replace(
      body,
      h('table', { class: 'data kv', 'data-testid': 'diag-table' }, h('caption', { class: 'visually-hidden' }, 'Diagnóstico'), h('tbody', null, rows().map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, v))))),
      h('h3', null, `Ficheiros ignorados (${ignored.length})`),
      ignored.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Ficheiro'), h('th', { scope: 'col' }, 'Motivo'))), h('tbody', null, ignored.map((i) => h('tr', null, h('td', null, h('code', null, i.path)), h('td', null, i.reason))))))
        : h('p', null, 'Nenhum.'),
      h('p', { class: 'hint' }, 'Ficheiros que não se conseguem ler (p.ex. ainda a sincronizar) são tentados de novo na leitura seguinte.'),
    );
  }

  replace(
    main,
    h('div', { class: 'view-head' }, h('h2', null, 'Diagnóstico'), h('div', { class: 'actions' },
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(asText());
            ui.toast('Diagnóstico copiado (não contém dados de grávidas).');
          } catch {
            ui.toast('Não foi possível copiar; selecione o texto da tabela.');
          }
        },
      }, 'Copiar diagnóstico'),
      c.mode !== 'none' ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => { if (await ui.confirmDialog('Esquecer a pasta', 'A aplicação deixa de usar a pasta atual neste PC e pede-a de novo. Não apaga nenhum ficheiro.', 'Esquecer')) { c.forgetFolder(); ui.go('#/inicio'); } } }, 'Esquecer pasta') : null,
    )),
    body,
  );
  render();
  return { title: 'Diagnóstico', update: render };
}
