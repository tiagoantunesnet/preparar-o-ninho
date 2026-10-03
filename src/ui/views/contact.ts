import { formatPtDate } from '../../core/dates';
import { toContact, type RecordView } from '../../core/records';
import type { UI, View } from '../app';
import { h, plural, replace } from '../dom';
import { badges, courseText, recordLink } from './common';

export function contactView(ui: UI, main: HTMLElement): View {
  const c = ui.ctl;
  const body = h('div');

  async function markContacted(v: RecordView, btn: HTMLButtonElement) {
    btn.disabled = true;
    const ev = c.newEvent(
      'update',
      v.id,
      {
        Contactada: { from: v.values.Contactada ?? '', to: 'Sim' },
        ...(v.values.DataContacto ? {} : { DataContacto: { from: '', to: c.today() } }),
      },
      v.rev,
    );
    const r = await ui.commitWithFallback(ev);
    btn.disabled = false;
    if (r?.ok) ui.toast(`${v.values.Nome} marcada como contactada.`);
  }

  function table(rows: RecordView[], caption: string): HTMLElement {
    if (!rows.length) return h('p', { class: 'empty' }, 'Nenhuma.');
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('caption', { class: 'visually-hidden' }, caption),
        h('thead', null, h('tr', null, ['Nome', 'Telefone', 'Email', 'Unidade', 'DUM', 'Idade gest.', 'Janela do curso', 'Proveniência', 'Indicações', 'Ação'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          null,
          rows.map((v) => {
            const btn = h('button', { type: 'button', class: 'btn btn-small' }, 'Marcar contactada');
            btn.setAttribute('aria-label', `Marcar ${v.values.Nome || 'registo'} como contactada`);
            btn.addEventListener('click', () => void markContacted(v, btn));
            return h(
              'tr',
              null,
              h('th', { scope: 'row' }, recordLink(v)),
              h('td', null, v.values.Telefone ? h('a', { href: `tel:${v.values.Telefone}` }, v.values.Telefone) : ''),
              h('td', null, v.values.Email ?? ''),
              h('td', null, v.values.UnidadeFuncional ?? ''),
              h('td', null, formatPtDate(v.values.DUM)),
              h('td', null, v.gaText),
              h('td', null, courseText(v)),
              h('td', null, v.values.ProvenienciaContacto ?? ''),
              h('td', null, badges(ui, v)),
              h('td', null, btn),
            );
          }),
        ),
      ),
    );
  }

  function render() {
    const { upcoming, inProgress } = toContact(c.views, c.today(), 4);
    replace(
      body,
      h(
        'section',
        { 'aria-labelledby': 'tc1' },
        h('h3', { id: 'tc1' }, `Janela do curso começa nas próximas 4 semanas (${upcoming.length})`),
        table(upcoming, 'Grávidas ativas não contactadas cuja janela do curso começa nas próximas 4 semanas'),
      ),
      h(
        'section',
        { 'aria-labelledby': 'tc2' },
        h('h3', { id: 'tc2' }, `Janela já a decorrer e ainda não contactadas (${inProgress.length})`),
        table(inProgress, 'Grávidas ativas não contactadas com a janela do curso já a decorrer'),
      ),
    );
  }

  replace(
    main,
    h('h2', null, 'A contactar'),
    h('p', null, 'Grávidas com estado "Ativa" e "Contactada" diferente de Sim. A janela do curso vai da semana 28 à 32 de gestação (DUM + 28 a 32 semanas). ', plural(c.views.length, 'registo', 'registos'), ' no total.'),
    body,
  );
  let shownVersion = c.dataVersion();
  render();
  return {
    update: () => {
      if (c.dataVersion() === shownVersion) return;
      shownVersion = c.dataVersion();
      render();
    },
    title: 'A contactar',
  };
}
