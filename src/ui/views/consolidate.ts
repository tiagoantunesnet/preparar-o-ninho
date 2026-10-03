import { ARCHIVE_AFTER_DAYS } from '../../app/controller';
import { formatPtDateTime } from '../../core/dates';
import type { UI, View } from '../app';
import { h, plural, replace } from '../dom';

export function consolidateView(ui: UI, main: HTMLElement): View {
  const c = ui.ctl;
  const info = h('div');
  const result = h('div', { role: 'status', 'aria-live': 'polite' });
  let busy = false;

  async function consolidate() {
    if (busy) return;
    busy = true;
    replace(result, h('p', null, 'A consolidar…'));
    const r = await c.consolidate();
    busy = false;
    if (!r.ok) {
      replace(result, h('div', { class: 'banner banner-error', role: 'alert' }, 'Não foi possível consolidar: ' + r.error));
      return;
    }
    if (r.how === 'download') {
      replace(
        result,
        h(
          'div',
          { class: 'banner banner-info' },
          h('p', null, 'Snapshot descarregado: ', h('code', null, r.path.split('/').pop()!)),
          h('p', null, 'Mova-o para ', h('code', null, `${c.folderName || 'RegistoGravidas'}\\data\\snapshots\\`), ' e carregue em "Atualizar".'),
        ),
      );
    } else {
      replace(result, h('div', { class: 'banner banner-info' }, `Snapshot gravado (${plural(r.snapshot.eventCount, 'evento incluído', 'eventos incluídos')}): `, h('code', null, r.path)));
    }
    render();
  }

  async function archive() {
    const n = c.archiveCandidates().length;
    const ok = await ui.confirmDialog(
      'Mover eventos antigos para data/archive',
      `Vão ser movidos ${plural(n, 'ficheiro de evento', 'ficheiros de eventos')} já incluídos num snapshot com mais de ${ARCHIVE_AFTER_DAYS} dias. Os ficheiros são copiados para data/archive, verificados, e só depois retirados de data/events. Os dados continuam no snapshot.`,
      'Mover',
    );
    if (!ok) return;
    replace(result, h('p', null, 'A mover…'));
    const r = await c.archiveOld();
    replace(
      result,
      h(
        'div',
        { class: r.failed.length ? 'banner banner-warn' : 'banner banner-info' },
        h('p', null, `${plural(r.moved, 'ficheiro movido', 'ficheiros movidos')} para data/archive.`),
        r.failed.length ? h('ul', null, r.failed.map((f) => h('li', null, h('code', null, f.path), ': ', f.error))) : null,
      ),
    );
    render();
  }

  function render() {
    const s = c.scan;
    const snaps = [...(s?.snapshots ?? [])].sort((a, b) => (a.snapshot.hlc < b.snapshot.hlc ? 1 : -1));
    const covered = new Set<string>();
    for (const x of snaps) for (const id of x.snapshot.eventIds) covered.add(id);
    const loose = (s?.events ?? []).filter((e) => !covered.has(e.id)).length;
    const candidates = c.archiveCandidates();
    replace(
      info,
      h(
        'ul',
        null,
        h('li', null, `${plural(s?.events.length ?? 0, 'evento', 'eventos')} na pasta data/events, dos quais ${loose} ainda não consolidados.`),
        h('li', null, `${plural(snaps.length, 'snapshot', 'snapshots')} em data/snapshots.`),
        snaps[0] ? h('li', null, `Último: ${formatPtDateTime(snaps[0].snapshot.ts)} por ${snaps[0].snapshot.author} (${plural(snaps[0].snapshot.eventCount, 'evento', 'eventos')}).`) : null,
      ),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void consolidate(), disabled: c.mode === 'none' }, 'Consolidar agora'),
      h('h3', null, 'Arquivo de eventos antigos'),
      c.mode !== 'full'
        ? h('p', null, 'Disponível apenas no modo completo.')
        : candidates.length
          ? h('div', null, h('p', null, `${plural(candidates.length, 'evento pode', 'eventos podem')} ser movidos para data/archive.`), h('button', { type: 'button', class: 'btn', onclick: () => void archive() }, `Mover ${candidates.length} para data/archive`))
          : h('p', null, `Não há eventos incluídos em snapshots com mais de ${ARCHIVE_AFTER_DAYS} dias.`),
    );
  }

  replace(
    main,
    h('h2', null, 'Consolidar'),
    h(
      'p',
      null,
      'Consolidar grava um "snapshot": o estado completo de todos os registos e a lista dos eventos incluídos. A aplicação passa a ler o snapshot e só os eventos posteriores, o que torna a abertura mais rápida. Não apaga nada. Faça-o, por exemplo, uma vez por mês.',
    ),
    info,
    result,
  );
  render();
  return { title: 'Consolidar', update: render };
}
