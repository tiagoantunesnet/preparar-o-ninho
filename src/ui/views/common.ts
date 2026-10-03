import { formatPtDate, formatPtDateTime } from '../../core/dates';
import type { RecordView } from '../../core/records';
import type { UI } from '../app';
import { h } from '../dom';

export function recordLink(v: RecordView): HTMLAnchorElement {
  return h('a', { href: `#/registo/${encodeURIComponent(v.id)}` }, v.values.Nome || '(sem nome)');
}

export function badges(ui: UI, v: RecordView): HTMLElement[] {
  const out: HTMLElement[] = [];
  const mark = ui.ctl.changeMark(v);
  if (mark === 'novo') out.push(h('span', { class: 'badge badge-new' }, 'Novo'));
  if (mark === 'alterado') out.push(h('span', { class: 'badge badge-changed' }, 'Alterado'));
  if (v.conflicts.length) out.push(h('span', { class: 'badge badge-conflict', title: 'Campos em conflito: ' + v.conflicts.join(', ') }, 'Conflito'));
  if (v.needsReview) out.push(h('span', { class: 'badge badge-review', title: v.values.AvisosImportacao }, 'Rever'));
  if (v.duplicateSNS) out.push(h('span', { class: 'badge badge-review' }, 'SNS repetido'));
  if (v.state.history.some((x) => ui.ctl.pendingIds.has(x.eventId))) out.push(h('span', { class: 'badge badge-pending', title: 'Gravado por descarga, ainda não encontrado na pasta' }, 'Por confirmar'));
  if (!v.hasCreate) out.push(h('span', { class: 'badge badge-review', title: 'O evento de criação ainda não chegou (sincronização em curso?)' }, 'Incompleto'));
  return out;
}

export function courseText(v: RecordView): string {
  return v.course ? `${formatPtDate(v.course.start)} – ${formatPtDate(v.course.end)}` : '';
}

export function lastChangeText(v: RecordView): string {
  return `${formatPtDateTime(v.last.ts)} · ${v.last.author}`;
}

export function downloadText(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: fileName, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
