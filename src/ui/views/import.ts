import { formatPtDate } from '../../core/dates';
import { uuid } from '../../core/ids';
import { allSNS } from '../../core/records';
import type { Change, RgEvent } from '../../core/types';
import { ImportError, nameDumKey, parseWorkbook, type ExistingIndex, type ImportPlan } from '../../import/excel';
import type { UI, View } from '../app';
import { h, plural, replace } from '../dom';

const STATUS_LABEL = { novo: 'Novo', duplicado: 'Duplicado (já existe)', 'duplicado-ficheiro': 'Repetido no ficheiro' } as const;

export function importView(ui: UI, main: HTMLElement): View {
  const c = ui.ctl;
  const preview = h('div', { 'aria-live': 'polite' });
  let fileData: ArrayBuffer | null = null;
  let fileName = '';
  let busy = false;

  const existing = (): ExistingIndex => ({
    sns: allSNS(c.views),
    nameDum: new Set(c.views.filter((v) => v.values.Nome && v.values.DUM).map((v) => nameDumKey(v.values.Nome, v.values.DUM))),
  });

  function plan(): ImportPlan | null {
    if (!fileData) return null;
    try {
      return parseWorkbook(fileData, c.config, existing());
    } catch (e) {
      replace(preview, h('div', { class: 'banner banner-error', role: 'alert' }, e instanceof ImportError ? e.message : 'Erro ao ler o ficheiro: ' + String(e)));
      return null;
    }
  }

  function renderPreview() {
    const p = plan();
    if (!p) return;
    const novos = p.rows.filter((r) => r.status === 'novo');
    replace(
      preview,
      h('h3', null, 'Pré-visualização'),
      h(
        'ul',
        { class: 'summary', 'data-testid': 'import-summary' },
        h('li', null, 'Ficheiro: ', h('strong', null, fileName), ` — folha «${p.sheetName}», cabeçalho na linha ${p.headerRow}`),
        h('li', null, h('strong', { 'data-testid': 'count-new' }, String(p.counts.novos)), ' novos registos a importar'),
        h('li', null, h('strong', { 'data-testid': 'count-dup' }, String(p.counts.duplicados)), ' duplicados (mesmo n.º SNS, ou nome + DUM se não houver SNS) — não serão importados'),
        h('li', null, h('strong', { 'data-testid': 'count-warn' }, String(p.counts.comAvisos)), ' novos com avisos — importados e assinalados "Rever"'),
        h('li', null, `${p.emptyRows} linhas vazias ignoradas; colunas ignoradas: ${p.ignoredColumns.join(', ')}`),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('caption', { class: 'visually-hidden' }, 'Linhas do Excel a importar'),
          h('thead', null, h('tr', null, ['Linha', 'Resultado', 'Nome', 'SNS', 'DUM', 'DPP', 'Unidade', 'Proveniência', 'Contactada', 'Avisos'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            p.rows.map((r) =>
              h(
                'tr',
                { class: r.status !== 'novo' ? 'row-muted' : r.warnings.length ? 'row-review' : undefined },
                h('td', null, String(r.rowNumber)),
                h('td', null, STATUS_LABEL[r.status]),
                h('th', { scope: 'row' }, r.values.Nome ?? ''),
                h('td', null, r.values.NumeroSNS ?? ''),
                h('td', null, formatPtDate(r.values.DUM)),
                h('td', null, formatPtDate(r.values.DPP)),
                h('td', null, r.values.UnidadeFuncional ?? ''),
                h('td', null, r.values.ProvenienciaContacto ?? ''),
                h('td', null, r.values.Contactada ?? ''),
                h('td', null, r.warnings.join('; ')),
              ),
            ),
          ),
        ),
      ),
      novos.length
        ? h('button', { type: 'button', class: 'btn btn-primary', id: 'do-import', onclick: () => void doImport() }, `Importar ${plural(novos.length, 'registo novo', 'registos novos')}`)
        : h('p', { class: 'banner banner-info' }, 'Não há registos novos para importar.'),
    );
  }

  async function doImport() {
    if (busy) return;
    // Volta a calcular com o estado atual (alguém pode ter importado entretanto).
    const p = plan();
    if (!p) return;
    const novos = p.rows.filter((r) => r.status === 'novo');
    if (!novos.length) {
      renderPreview();
      return;
    }
    const ok = await ui.confirmDialog(
      'Confirmar importação',
      `Vão ser criados ${plural(novos.length, 'registo', 'registos')}${c.mode === 'compat' ? '. No modo compatível é descarregado um ficheiro ZIP que terá de extrair para data\\events' : ''}.`,
      'Importar',
    );
    if (!ok) return;
    busy = true;
    const events: RgEvent[] = novos.map((r) => {
      const changes: Record<string, Change> = {};
      for (const [k, v] of Object.entries(r.values)) if (v) changes[k] = { from: null, to: v };
      return c.newEvent('create', uuid(), changes, null);
    });
    replace(preview, h('p', { role: 'status' }, `A gravar ${events.length} registos…`));
    const res = await c.commitMany(events);
    busy = false;
    if (res.how === 'download') {
      if (res.written) ui.showDownloadInstructions(['data/events'], !!res.persisted, events.length > 1);
      replace(preview, res.written ? h('p', { class: 'banner banner-info' }, `${plural(res.written, 'registo preparado', 'registos preparados')}. Extraia/mova o ficheiro descarregado para data\\events e carregue em "Atualizar".`) : h('p', { class: 'banner banner-error' }, 'Falhou: ' + (res.error ?? '')));
      return;
    }
    if (res.failed.length) {
      replace(
        preview,
        h(
          'div',
          { class: 'banner banner-error', role: 'alert' },
          h('p', null, `Foram gravados ${res.written} registos; ${res.failed.length} falharam (${res.error ?? 'erro de escrita'}).`),
          h('p', null, 'Nada se perdeu: pode guardar os que falharam por descarga, ou voltar a importar o mesmo ficheiro mais tarde (os já gravados são detetados como duplicados).'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                const d = c.commitByDownload(res.failed);
                if (d.ok && d.how === 'download') ui.showDownloadInstructions(['data/events'], d.persisted, res.failed.length > 1);
              },
            },
            'Guardar os que falharam por descarga',
          ),
        ),
      );
      return;
    }
    replace(preview, h('p', { class: 'banner banner-info', role: 'status' }, `Importação concluída: ${plural(res.written, 'registo criado', 'registos criados')}.`), h('p', null, h('a', { href: '#/registos' }, 'Ver registos')));
  }

  const input = h('input', {
    type: 'file',
    id: 'xlsx-file',
    accept: '.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    onchange: async () => {
      const f = input.files?.[0];
      if (!f) return;
      fileName = f.name;
      fileData = await f.arrayBuffer();
      renderPreview();
    },
  });

  replace(
    main,
    h('h2', null, 'Importar o Excel original'),
    h('p', null, 'Escolha o ficheiro Excel do registo de grávidas (folha «Grávidas 2026»). O ficheiro é lido só neste PC; nada é enviado para a internet. Antes de importar vê uma pré-visualização com novos, duplicados e avisos.'),
    c.mode === 'none' ? h('p', { class: 'banner banner-warn' }, 'Escolha primeiro a pasta RegistoGravidas.') : null,
    h('div', { class: 'field' }, h('label', { for: 'xlsx-file' }, 'Ficheiro Excel (.xlsx)'), input),
    preview,
  );
  return { title: 'Importar Excel' };
}
