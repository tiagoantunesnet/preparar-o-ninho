import { toCsv } from '../../core/csv';
import { formatPtDate } from '../../core/dates';
import { applyFilters, DEFAULT_FILTERS, sortViews, type Filters, type RecordView, type SortKey } from '../../core/records';
import { ESTADOS } from '../../core/types';
import type { UI, View } from '../app';
import { h, plural, replace } from '../dom';
import { badges, courseText, downloadText, lastChangeText, recordLink } from './common';

// Mantém-se entre navegações (não inclui dados pessoais além da pesquisa, que fica só em memória).
let filters: Filters = { ...DEFAULT_FILTERS };
let sort: { key: SortKey; dir: 'asc' | 'desc' } = { key: 'Nome', dir: 'asc' };

const COLUMNS: { key: SortKey | null; label: string }[] = [
  { key: 'Nome', label: 'Nome' },
  { key: 'NumeroSNS', label: 'N.º SNS' },
  { key: 'UnidadeFuncional', label: 'Unidade' },
  { key: 'DUM', label: 'DUM' },
  { key: 'IG', label: 'Idade gest.' },
  { key: 'DPP', label: 'DPP' },
  { key: 'Curso', label: 'Janela do curso' },
  { key: 'Contactada', label: 'Contactada' },
  { key: 'Estado', label: 'Estado' },
  { key: 'Alterado', label: 'Última alteração' },
  { key: null, label: 'Indicações' },
];

export function listView(ui: UI, main: HTMLElement): View {
  const c = ui.ctl;
  const count = h('p', { class: 'result-count', role: 'status', 'aria-live': 'polite', 'data-testid': 'result-count' });
  const tableWrap = h('div', { class: 'table-wrap' });

  const q = h('input', { id: 'f-q', type: 'search', value: filters.q, placeholder: 'Nome ou n.º SNS', oninput: () => set({ q: q.value }) });
  const unidade = h('select', { id: 'f-unidade', onchange: () => set({ unidade: unidade.value }) });
  const contactada = h('select', { id: 'f-contactada', onchange: () => set({ contactada: contactada.value as Filters['contactada'] }) }, h('option', { value: '' }, 'Todas'), h('option', { value: 'Sim' }, 'Sim'), h('option', { value: 'Não' }, 'Não'));
  const estado = h(
    'select',
    { id: 'f-estado', onchange: () => set({ estado: estado.value }) },
    h('option', { value: '' }, 'Todos exceto arquivadas'),
    h('option', { value: '*' }, 'Todos'),
    ESTADOS.map((e) => h('option', { value: e }, e)),
  );
  const conflito = h('input', { id: 'f-conflito', type: 'checkbox', checked: filters.conflito, onchange: () => set({ conflito: conflito.checked }) });
  const rever = h('input', { id: 'f-rever', type: 'checkbox', checked: filters.rever, onchange: () => set({ rever: rever.checked }) });
  const curso = h('input', {
    id: 'f-curso',
    type: 'number',
    min: '0',
    max: '52',
    inputmode: 'numeric',
    value: filters.cursoSemanas === null ? '' : String(filters.cursoSemanas),
    'aria-describedby': 'f-curso-help',
    oninput: () => {
      const n = curso.value.trim() === '' ? null : Math.max(0, Math.min(52, Math.floor(Number(curso.value))));
      set({ cursoSemanas: n === null || Number.isNaN(n) ? null : n });
    },
  });
  contactada.value = filters.contactada;
  estado.value = filters.estado;

  function fillUnidades() {
    const cur = filters.unidade;
    const opts = new Set(c.config.UnidadeFuncional);
    for (const v of c.views) if (v.values.UnidadeFuncional) opts.add(v.values.UnidadeFuncional);
    replace(unidade, h('option', { value: '' }, 'Todas'), [...opts].map((u) => h('option', { value: u }, u)));
    unidade.value = cur;
  }

  function set(p: Partial<Filters>) {
    filters = { ...filters, ...p };
    renderTable();
  }

  function current(): RecordView[] {
    return sortViews(applyFilters(c.views, filters, c.today()), sort.key, sort.dir);
  }

  function exportCsv() {
    const rows = current();
    const header = ['Nome', 'N.º SNS', 'Data de nascimento', 'Email', 'Telefone', 'Unidade funcional', 'Médico assistente', 'DUM', 'Idade gestacional', 'DPP', 'Início janela curso', 'Fim janela curso', 'Proveniência do contacto', 'Contactada', 'Data do contacto', 'Estado', 'Observações', 'Conflito', 'Avisos importação'];
    const data = rows.map((v) => [
      v.values.Nome,
      v.values.NumeroSNS,
      formatPtDate(v.values.DataNascimento),
      v.values.Email,
      v.values.Telefone,
      v.values.UnidadeFuncional,
      v.values.MedicoAssistente,
      formatPtDate(v.values.DUM),
      v.gaText,
      formatPtDate(v.values.DPP),
      formatPtDate(v.course?.start),
      formatPtDate(v.course?.end),
      v.values.ProvenienciaContacto,
      v.values.Contactada,
      formatPtDate(v.values.DataContacto),
      v.estado,
      v.values.Observacoes,
      v.conflicts.length ? 'Sim' : '',
      v.values.AvisosImportacao,
    ]);
    const stamp = c.today();
    downloadText(`registo_gravidas_${stamp}.csv`, toCsv(header, data), 'text/csv;charset=utf-8');
    ui.toast(`Exportados ${plural(rows.length, 'registo', 'registos')} para CSV (pasta Transferências). Atenção: o ficheiro contém dados pessoais.`);
  }

  function sortBy(key: SortKey) {
    sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    renderTable();
    (tableWrap.querySelector(`button[data-sort="${key}"]`) as HTMLElement | null)?.focus();
  }

  function renderTable() {
    const rows = current();
    count.textContent = `${plural(rows.length, 'registo', 'registos')} de ${c.views.length}`;
    if (!rows.length) {
      replace(tableWrap, h('p', { class: 'empty' }, c.views.length ? 'Nenhum registo corresponde aos filtros.' : 'Ainda não há registos. Crie um novo ou importe o Excel.'));
      return;
    }
    const thead = h(
      'thead',
      null,
      h(
        'tr',
        null,
        COLUMNS.map((col) => {
          if (!col.key) return h('th', { scope: 'col' }, col.label);
          const active = sort.key === col.key;
          return h(
            'th',
            { scope: 'col', 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
            h('button', { type: 'button', class: 'sort', 'data-sort': col.key, onclick: () => sortBy(col.key!) }, col.label, h('span', { 'aria-hidden': 'true', class: 'sort-ind' }, active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')),
          );
        }),
      ),
    );
    const tbody = h(
      'tbody',
      null,
      rows.map((v) =>
        h(
          'tr',
          { class: [v.conflicts.length ? 'row-conflict' : '', ui.ctl.changeMark(v) ? 'row-changed' : ''].join(' ').trim() || undefined },
          h('th', { scope: 'row' }, recordLink(v)),
          h('td', null, v.values.NumeroSNS ?? ''),
          h('td', null, v.values.UnidadeFuncional ?? ''),
          h('td', null, formatPtDate(v.values.DUM)),
          h('td', null, v.gaText),
          h('td', null, formatPtDate(v.values.DPP)),
          h('td', null, courseText(v)),
          h('td', null, v.values.Contactada ?? ''),
          h('td', null, v.estado),
          h('td', { class: 'small' }, lastChangeText(v)),
          h('td', null, badges(ui, v)),
        ),
      ),
    );
    replace(tableWrap, h('table', { class: 'data' }, h('caption', { class: 'visually-hidden' }, 'Registos de grávidas (clique no cabeçalho para ordenar)'), thead, tbody));
  }

  replace(
    main,
    h('div', { class: 'view-head' }, h('h2', null, 'Registos'), h('div', { class: 'actions' }, h('a', { href: '#/nova', class: 'btn btn-primary' }, 'Nova grávida'), h('button', { type: 'button', class: 'btn', onclick: exportCsv }, 'Exportar vista para CSV'))),
    h(
      'form',
      { class: 'filters', role: 'search', 'aria-label': 'Pesquisa e filtros', onsubmit: (e: Event) => e.preventDefault() },
      h('div', { class: 'field' }, h('label', { for: 'f-q' }, 'Pesquisar'), q),
      h('div', { class: 'field' }, h('label', { for: 'f-unidade' }, 'Unidade'), unidade),
      h('div', { class: 'field' }, h('label', { for: 'f-contactada' }, 'Contactada'), contactada),
      h('div', { class: 'field' }, h('label', { for: 'f-estado' }, 'Estado'), estado),
      h('div', { class: 'field' }, h('label', { for: 'f-curso' }, 'Curso começa nas próximas'), h('div', { class: 'inline' }, curso, h('span', { id: 'f-curso-help' }, 'semanas'))),
      h('div', { class: 'field field-check' }, conflito, h('label', { for: 'f-conflito' }, 'Só com conflito')),
      h('div', { class: 'field field-check' }, rever, h('label', { for: 'f-rever' }, 'Só para rever')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost',
          onclick: () => {
            filters = { ...DEFAULT_FILTERS };
            ui.go('#/registos');
          },
        },
        'Limpar filtros',
      ),
    ),
    c.sinceMarker
      ? h('p', { class: 'hint' }, 'Os registos marcados "Novo"/"Alterado" mudaram desde a sua última visita. ', h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => c.markAllSeen() }, 'Marcar tudo como visto'))
      : null,
    count,
    tableWrap,
  );
  let shownVersion = c.dataVersion();
  fillUnidades();
  renderTable();

  return {
    title: 'Registos',
    update: () => {
      if (c.dataVersion() === shownVersion) return;
      shownVersion = c.dataVersion();
      fillUnidades();
      renderTable();
    },
  };
}
