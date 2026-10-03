import { formatPtDateTime } from '../../core/dates';
import type { HistoryEntry } from '../../core/merge';
import { FIELD_LABELS, type EventType, type FieldName } from '../../core/types';
import type { UI, View } from '../app';
import { h, replace } from '../dom';

const VERB: Record<EventType, string> = {
  create: 'criou',
  update: 'alterou',
  archive: 'arquivou',
  restore: 'restaurou',
  resolve: 'resolveu um conflito em',
};

interface FeedItem {
  eventId: string;
  hlc: string;
  ts: string;
  author: string;
  deviceId: string;
  type: EventType;
  recordId: string;
  fields: string[];
}

const LIMIT = 200;

export function recentView(ui: UI, main: HTMLElement): View {
  const c = ui.ctl;
  const list = h('ol', { class: 'feed', reversed: true });

  function render() {
    const items = new Map<string, FeedItem>();
    for (const rec of Object.values(c.state.records)) {
      for (const x of rec.history as HistoryEntry[]) {
        let it = items.get(x.eventId);
        if (!it) {
          it = { eventId: x.eventId, hlc: x.hlc, ts: x.ts, author: x.author, deviceId: x.deviceId, type: x.type, recordId: rec.recordId, fields: [] };
          items.set(x.eventId, it);
        }
        it.fields.push(x.field);
      }
    }
    const sorted = [...items.values()].sort((a, b) => (a.hlc < b.hlc ? 1 : a.hlc > b.hlc ? -1 : 0)).slice(0, LIMIT);
    const m = c.sinceMarker;
    replace(
      list,
      sorted.length
        ? sorted.map((it) => {
            const v = c.record(it.recordId);
            const isNew = !!m && it.hlc > m && it.deviceId !== c.deviceId;
            return h(
              'li',
              { class: isNew ? 'feed-new' : undefined },
              h('span', { class: 'when' }, formatPtDateTime(it.ts)),
              ' ',
              isNew ? h('span', { class: 'badge badge-new' }, 'Novo desde a última visita') : null,
              c.pendingIds.has(it.eventId) ? h('span', { class: 'badge badge-pending' }, 'Por confirmar') : null,
              ' ',
              h('strong', null, it.author),
              ` ${VERB[it.type]} `,
              h('a', { href: `#/registo/${encodeURIComponent(it.recordId)}` }, v?.values.Nome || '(registo sem nome)'),
              it.type === 'update' || it.type === 'resolve' ? h('span', { class: 'fields' }, ': ' + it.fields.map((f) => FIELD_LABELS[f as FieldName] ?? f).join(', ')) : null,
            );
          })
        : h('li', null, 'Ainda não há alterações.'),
    );
  }

  replace(
    main,
    h('div', { class: 'view-head' }, h('h2', null, 'Alterações recentes'), h('button', { type: 'button', class: 'btn', onclick: () => c.markAllSeen() }, 'Marcar tudo como visto')),
    h('p', { class: 'hint' }, `Últimas ${LIMIT} alterações, mais recentes primeiro. A marca "última visita" fica guardada só neste PC e não contém dados pessoais.`),
    list,
  );
  let shownVersion = c.dataVersion();
  render();
  return {
    update: () => {
      if (c.dataVersion() === shownVersion) return;
      shownVersion = c.dataVersion();
      render();
    },
    title: 'Alterações recentes',
  };
}
