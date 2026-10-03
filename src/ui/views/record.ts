import { courseWindow, defaultDpp, formatGestationalAge, formatPtDate, formatPtDateTime, gestationalAge, parsePtDate } from '../../core/dates';
import { uuid } from '../../core/ids';
import { conflictHeads } from '../../core/merge';
import { snsIndex, type RecordView } from '../../core/records';
import { DATE_FIELDS, ESTADOS, FIELD_LABELS, FIELDS, type Change, type EventType, type FieldName, type RecordValues } from '../../core/types';
import { normalizePhone, normalizeSNS, validateRecord } from '../../core/validation';
import type { UI, View } from '../app';
import { h, replace } from '../dom';
import { badges } from './common';

type Kind = 'text' | 'date' | 'email' | 'tel' | 'select' | 'textarea' | 'digits';

interface FieldDef {
  name: FieldName;
  kind: Kind;
  required?: boolean;
  hint?: string;
  options?: () => string[];
}

const ACTION_LABEL: Record<EventType, string> = {
  create: 'Criação',
  update: 'Alteração',
  archive: 'Arquivo',
  restore: 'Restauro',
  resolve: 'Resolução de conflito',
};

export function displayValue(field: string, v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return DATE_FIELDS.has(field) ? formatPtDate(v) : v;
}

export function recordView(ui: UI, main: HTMLElement, param: string): View {
  const c = ui.ctl;
  const isNew = !param;
  const recordId = param || uuid();
  let base: RecordView | undefined = c.record(recordId);

  if (!isNew && !base) {
    const render = () => {
      base = c.record(recordId);
      if (base) ui.go(`#/registo/${encodeURIComponent(recordId)}`);
    };
    replace(main, h('h2', null, 'Registo não encontrado'), h('p', null, 'Este registo não existe nesta pasta ou ainda não foi sincronizado.'), h('p', null, h('a', { href: '#/registos' }, 'Voltar aos registos')));
    return { title: 'Registo não encontrado', update: render };
  }

  const baseline: RecordValues = isNew ? { Estado: 'Ativa' } : { ...base!.values };
  const baseRev = isNew ? null : base!.rev;
  // Um evento tardio (relógio atrasado, PC offline) pode mudar o registo sem
  // mudar o rev; por isso compara-se também o histórico e os conflitos.
  const contentSig = (v: RecordView) => `${v.rev}|${v.state.history.length}|${v.conflicts.join(',')}|${v.state.history.filter((x) => c.pendingIds.has(x.eventId)).length}`;
  const baseSig = isNew ? '' : contentSig(base!);
  const archived = (baseline.Estado ?? '') === 'Arquivada';

  const withCurrent = (list: string[], cur: string | undefined) => (cur && !list.includes(cur) ? [...list, cur] : list);
  const defs: FieldDef[] = [
    { name: 'Nome', kind: 'text', required: true },
    { name: 'NumeroSNS', kind: 'digits', hint: '9 dígitos' },
    { name: 'DataNascimento', kind: 'date' },
    { name: 'Email', kind: 'email' },
    { name: 'Telefone', kind: 'tel', hint: '9 dígitos (ex.: 912345678)' },
    { name: 'UnidadeFuncional', kind: 'select', options: () => withCurrent(c.config.UnidadeFuncional, baseline.UnidadeFuncional) },
    { name: 'MedicoAssistente', kind: 'text' },
    { name: 'DUM', kind: 'date', required: true, hint: 'Data da última menstruação' },
    { name: 'DPP', kind: 'date', hint: 'Por omissão DUM + 280 dias; pode alterar' },
    { name: 'ProvenienciaContacto', kind: 'select', options: () => withCurrent(c.config.ProvenienciaContacto, baseline.ProvenienciaContacto) },
    { name: 'Contactada', kind: 'select', options: () => ['Sim', 'Não'] },
    { name: 'DataContacto', kind: 'date' },
    { name: 'Observacoes', kind: 'textarea' },
    { name: 'Estado', kind: 'select', options: () => (archived ? [...ESTADOS] : ESTADOS.filter((e) => e !== 'Arquivada')) },
  ];

  const inputs = new Map<FieldName, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const errEls = new Map<FieldName, HTMLElement>();
  let dppAuto = isNew || !baseline.DPP || baseline.DPP === defaultDpp(baseline.DUM);
  let saving = false;
  let inflight: { ev: ReturnType<typeof c.newEvent>; sig: string } | null = null;
  let ackWarnings = '';
  let initialSig = '';

  const summary = h('div', { class: 'form-summary', tabindex: '-1', 'data-testid': 'form-summary' });
  const saveStatus = h('p', { class: 'save-status', role: 'status', 'aria-live': 'polite', 'data-testid': 'save-status' });
  const remoteNotice = h('div', { 'aria-live': 'polite' });
  const computed = h('dl', { class: 'computed' });
  const reviewed = h('input', { type: 'checkbox', id: 'f-reviewed' });

  function makeInput(d: FieldDef) {
    const id = `f-${d.name}`;
    const describedBy = [d.hint ? `${id}-hint` : '', `${id}-err`].filter(Boolean).join(' ');
    const common = { id, name: d.name, 'aria-describedby': describedBy, required: d.required, 'aria-required': d.required ? 'true' : undefined, disabled: archived && d.name !== 'Observacoes' ? true : undefined };
    const v = baseline[d.name] ?? '';
    let el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    switch (d.kind) {
      case 'select': {
        const opts = d.options!();
        el = h('select', common, h('option', { value: '' }, '— escolher —'), opts.map((o) => h('option', { value: o }, o + (d.name !== 'Estado' && d.name !== 'Contactada' && !(d.name === 'UnidadeFuncional' ? c.config.UnidadeFuncional : c.config.ProvenienciaContacto).includes(o) ? ' (fora da lista)' : ''))));
        if (d.name === 'Estado') el.querySelector('option[value=""]')?.remove();
        el.value = v || (d.name === 'Estado' ? 'Ativa' : '');
        break;
      }
      case 'textarea':
        el = h('textarea', { ...common, rows: '3' });
        el.value = v;
        break;
      case 'date':
        el = h('input', { ...common, type: 'text', inputmode: 'numeric', placeholder: 'dd/mm/aaaa', autocomplete: 'off', maxlength: '10', value: formatPtDate(v), class: 'date' });
        el.addEventListener('blur', () => {
          const iso = parsePtDate(el.value);
          if (iso) el.value = formatPtDate(iso);
        });
        break;
      case 'digits':
        el = h('input', { ...common, type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '11', value: v });
        break;
      case 'tel':
        el = h('input', { ...common, type: 'tel', autocomplete: 'off', maxlength: '16', value: v });
        break;
      case 'email':
        el = h('input', { ...common, type: 'email', autocomplete: 'off', value: v });
        break;
      default:
        el = h('input', { ...common, type: 'text', autocomplete: 'off', value: v });
    }
    inputs.set(d.name, el);
    const err = h('p', { id: `${id}-err`, class: 'field-error' });
    errEls.set(d.name, err);
    return h(
      'div',
      { class: `field field-${d.name}` },
      h('label', { for: id }, FIELD_LABELS[d.name], d.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
      el,
      d.hint ? h('p', { id: `${id}-hint`, class: 'hint' }, d.hint) : null,
      err,
    );
  }

  function rawSig(): string {
    return JSON.stringify([...inputs].map(([k, el]) => [k, el.value])) + reviewed.checked;
  }

  function collect(): { values: RecordValues; dateErrors: Record<string, string> } {
    const values: RecordValues = {};
    const dateErrors: Record<string, string> = {};
    for (const d of defs) {
      const raw = inputs.get(d.name)!.value.trim();
      if (d.kind === 'date') {
        if (!raw) values[d.name] = '';
        else {
          const iso = parsePtDate(raw);
          if (iso) values[d.name] = iso;
          else {
            values[d.name] = '';
            dateErrors[d.name] = 'Data inválida. Use o formato dd/mm/aaaa.';
          }
        }
      } else if (d.kind === 'digits') values[d.name] = normalizeSNS(raw);
      else if (d.kind === 'tel') values[d.name] = normalizePhone(raw);
      else values[d.name] = raw;
    }
    return { values, dateErrors };
  }

  function updateComputed() {
    const { values } = collect();
    const ga = gestationalAge(values.DUM, c.today());
    const cw = courseWindow(values.DUM);
    replace(
      computed,
      h('div', null, h('dt', null, 'Idade gestacional (hoje)'), h('dd', { 'data-testid': 'ga' }, ga ? formatGestationalAge(ga) : '—')),
      h('div', null, h('dt', null, 'Janela do curso (28–32 semanas)'), h('dd', { 'data-testid': 'course' }, cw ? `${formatPtDate(cw.start)} a ${formatPtDate(cw.end)}` : '—')),
    );
  }

  function showErrors(errors: Record<string, string>, warnings: Record<string, string>) {
    for (const [k, el] of errEls) {
      const msg = errors[k] ?? warnings[k] ?? '';
      el.textContent = msg;
      el.className = errors[k] ? 'field-error' : warnings[k] ? 'field-warning' : 'field-error';
      const input = inputs.get(k)!;
      if (errors[k]) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    const errList = Object.entries(errors);
    const warnList = Object.entries(warnings);
    if (!errList.length && !warnList.length) {
      replace(summary);
      summary.removeAttribute('role');
      return;
    }
    const link = ([k, m]: [string, string]) => h('li', null, h('a', { href: `#f-${k}`, onclick: (e: Event) => { e.preventDefault(); inputs.get(k as FieldName)?.focus(); } }, `${FIELD_LABELS[k as FieldName] ?? k}: ${m}`));
    summary.setAttribute('role', 'alert');
    replace(
      summary,
      errList.length ? h('div', { class: 'banner banner-error' }, h('h3', null, 'Corrija os seguintes erros:'), h('ul', null, errList.map(link))) : null,
      !errList.length && warnList.length
        ? h('div', { class: 'banner banner-warn' }, h('h3', null, 'Avisos — verifique e carregue em "Guardar" de novo para confirmar:'), h('ul', null, warnList.map(link)))
        : null,
    );
    summary.focus();
  }

  function diff(values: RecordValues): Record<string, Change> {
    const changes: Record<string, Change> = {};
    for (const d of defs) {
      const from = baseline[d.name] ?? '';
      const to = values[d.name] ?? '';
      if (from !== to) changes[d.name] = { from: isNew ? null : from, to };
    }
    if (isNew) for (const k of Object.keys(changes)) if (changes[k].to === '') delete changes[k];
    if (reviewed.checked && baseline.AvisosImportacao) changes.AvisosImportacao = { from: baseline.AvisosImportacao, to: '' };
    return changes;
  }

  async function save(e?: Event) {
    e?.preventDefault();
    if (saving) return;
    const { values, dateErrors } = collect();
    const today = c.today();
    const { errors, warnings } = validateRecord(values, { config: c.config, today, snsIndex: snsIndex(c.views), recordId });
    Object.assign(errors, dateErrors);
    for (const k of Object.keys(warnings)) {
      // Avisos de "fora da lista" só interessam se o valor foi alterado.
      if ((k === 'UnidadeFuncional' || k === 'ProvenienciaContacto') && values[k] === baseline[k]) delete warnings[k];
    }
    if (Object.keys(errors).length) {
      showErrors(errors, warnings);
      saveStatus.textContent = 'Não gravado: há erros no formulário.';
      return;
    }
    const sigNow = rawSig();
    if (Object.keys(warnings).length && ackWarnings !== sigNow) {
      ackWarnings = sigNow;
      showErrors({}, warnings);
      saveStatus.textContent = 'Há avisos. Carregue em "Guardar" de novo para confirmar.';
      return;
    }
    showErrors({}, {});
    const changes = diff(values);
    if (!Object.keys(changes).length) {
      saveStatus.textContent = 'Sem alterações para gravar.';
      return;
    }
    if (isNew && !changes.Estado) changes.Estado = { from: null, to: 'Ativa' };
    const sig = JSON.stringify(changes);
    const ev = inflight && inflight.sig === sig ? inflight.ev : c.newEvent(isNew ? 'create' : 'update', recordId, changes, baseRev);
    inflight = { ev, sig };
    saving = true;
    saveBtn.disabled = true;
    saveStatus.textContent = 'A gravar…';
    const r = await ui.commitWithFallback(ev);
    saving = false;
    saveBtn.disabled = false;
    if (!r || !r.ok) {
      saveStatus.textContent = 'Não gravado. Os dados continuam no formulário — pode tentar de novo.';
      return;
    }
    inflight = null;
    initialSig = rawSig();
    ui.toast(r.how === 'folder' ? 'Gravado na pasta partilhada.' : 'Gravado por descarga — mova o ficheiro para a pasta indicada.');
    ui.go(`#/registo/${encodeURIComponent(recordId)}`);
  }

  async function archiveOrRestore() {
    const cur = c.record(recordId);
    if (!cur) return;
    if (rawSig() !== initialSig && !window.confirm('Tem alterações por gravar no formulário. Continuar e perdê-las?')) return;
    let type: EventType;
    let to: string;
    if (cur.estado === 'Arquivada') {
      type = 'restore';
      const lastArchive = [...cur.state.history].reverse().find((x) => x.field === 'Estado' && x.to === 'Arquivada');
      const prev = lastArchive?.from;
      to = prev && prev !== 'Arquivada' ? prev : 'Ativa';
    } else {
      const ok = await ui.confirmDialog('Arquivar registo', `O registo de ${cur.values.Nome || '(sem nome)'} deixa de aparecer nas listas (pode ser restaurado). Nada é apagado.`, 'Arquivar');
      if (!ok) return;
      type = 'archive';
      to = 'Arquivada';
    }
    const ev = c.newEvent(type, recordId, { Estado: { from: cur.values.Estado ?? '', to } }, cur.rev);
    const r = await ui.commitWithFallback(ev);
    if (r?.ok) {
      initialSig = rawSig();
      ui.toast(type === 'archive' ? 'Registo arquivado.' : 'Registo restaurado.');
      ui.go(`#/registo/${encodeURIComponent(recordId)}`);
    }
  }

  function conflictPanel(v: RecordView): HTMLElement | null {
    if (!v.conflicts.length) return null;
    const groups = v.conflicts.map((f) => {
      const heads = conflictHeads(v.state, f);
      const name = `cf-${f}`;
      return h(
        'fieldset',
        { class: 'conflict-field' },
        h('legend', null, FIELD_LABELS[f as FieldName] ?? f),
        heads.map((hd, i) =>
          h(
            'div',
            { class: 'radio' },
            h('input', { type: 'radio', name, id: `${name}-${i}`, value: hd.value ?? '', checked: hd.value === v.values[f] }),
            h('label', { for: `${name}-${i}` }, h('strong', null, displayValue(f, hd.value)), ` — ${hd.author}, ${formatPtDateTime(hd.ts)}`),
          ),
        ),
      );
    });
    const resolve = async () => {
      if (rawSig() !== initialSig && !window.confirm('Tem alterações por gravar no formulário. Resolver o conflito e perdê-las?')) return;
      const cur = c.record(recordId);
      if (!cur) return;
      const changes: Record<string, Change> = {};
      for (const f of cur.conflicts) {
        const sel = panel.querySelector<HTMLInputElement>(`input[name="cf-${f}"]:checked`);
        if (!sel) {
          ui.toast(`Escolha um valor para "${FIELD_LABELS[f as FieldName] ?? f}".`);
          return;
        }
        changes[f] = { from: cur.values[f] ?? '', to: sel.value };
      }
      const r = await ui.commitWithFallback(c.newEvent('resolve', recordId, changes, cur.rev));
      if (r?.ok) {
        initialSig = rawSig();
        ui.toast('Conflito resolvido.');
        ui.go(`#/registo/${encodeURIComponent(recordId)}`);
      }
    };
    const panel = h(
      'section',
      { class: 'banner banner-conflict', 'aria-labelledby': 'cf-title', 'data-testid': 'conflict-panel' },
      h('h3', { id: 'cf-title' }, 'Conflito: alterações simultâneas'),
      h('p', null, 'Duas pessoas alteraram os mesmos campos sem verem a alteração uma da outra. Escolha o valor correto de cada campo (está pré-selecionado o que a aplicação mostra agora).'),
      groups,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void resolve() }, 'Resolver conflito'),
    );
    return panel;
  }

  function historySection(v: RecordView | undefined): HTMLElement {
    if (!v) return h('section', null);
    // Mais recentes primeiro; dentro do mesmo evento, pela ordem do formulário.
    const order = (f: string) => {
      const i = (FIELDS as readonly string[]).indexOf(f);
      return i < 0 ? FIELDS.length : i;
    };
    const desc = [...v.state.history].reverse();
    const rank = new Map<string, number>();
    desc.forEach((x, i) => rank.has(x.eventId) || rank.set(x.eventId, i));
    const rows = desc.sort((a, b) => rank.get(a.eventId)! - rank.get(b.eventId)! || order(a.field) - order(b.field));
    return h(
      'section',
      { 'aria-labelledby': 'hist-title', class: 'history' },
      h('h3', { id: 'hist-title' }, 'Histórico'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('caption', { class: 'visually-hidden' }, 'Histórico de alterações deste registo'),
          h('thead', null, h('tr', null, ['Quando', 'Quem', 'Ação', 'Campo', 'Antes', 'Depois'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            rows.map((x) =>
              h(
                'tr',
                { class: c.pendingIds.has(x.eventId) ? 'row-pending' : undefined },
                h('td', null, formatPtDateTime(x.ts), c.pendingIds.has(x.eventId) ? h('span', { class: 'badge badge-pending' }, 'Por confirmar') : null),
                h('td', null, x.author),
                h('td', null, ACTION_LABEL[x.type]),
                h('td', null, FIELD_LABELS[x.field as FieldName] ?? x.field),
                h('td', null, x.type === 'create' ? '' : displayValue(x.field, x.from)),
                h('td', null, displayValue(x.field, x.to)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Criar registo' : 'Guardar alterações');
  const fs = (legend: string, names: FieldName[], extra?: HTMLElement) =>
    h('fieldset', { class: 'group' }, h('legend', null, legend), h('div', { class: 'grid' }, names.map((n) => makeInput(defs.find((d) => d.name === n)!))), extra ?? null);

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e: Event) => void save(e), 'aria-labelledby': 'rec-title' },
    summary,
    fs('Identificação', ['Nome', 'NumeroSNS', 'DataNascimento', 'Email', 'Telefone']),
    fs('Gravidez', ['UnidadeFuncional', 'MedicoAssistente', 'DUM', 'DPP'], computed),
    fs('Contacto', ['ProvenienciaContacto', 'Contactada', 'DataContacto', 'Estado', 'Observacoes']),
    baseline.AvisosImportacao
      ? h('div', { class: 'banner banner-review' }, h('h3', null, 'Para rever (importação)'), h('p', null, baseline.AvisosImportacao), h('div', { class: 'field-check' }, reviewed, h('label', { for: 'f-reviewed' }, 'Revisto — remover este aviso ao gravar')))
      : null,
    h(
      'div',
      { class: 'actions sticky-actions' },
      saveBtn,
      h('a', { href: '#/registos', class: 'btn btn-ghost' }, 'Voltar'),
      !isNew ? h('button', { type: 'button', class: 'btn', onclick: () => void archiveOrRestore() }, archived ? 'Restaurar' : 'Arquivar') : null,
      saveStatus,
    ),
  );

  const dum = () => inputs.get('DUM')!;
  const dpp = () => inputs.get('DPP')!;

  const title = isNew ? 'Nova grávida' : base!.values.Nome || '(sem nome)';
  replace(
    main,
    h('div', { class: 'view-head' }, h('h2', { id: 'rec-title' }, title), !isNew ? h('div', null, badges(ui, base!)) : null),
    remoteNotice,
    !isNew ? conflictPanel(base!) : null,
    archived ? h('p', { class: 'banner banner-info' }, 'Este registo está arquivado. Restaure-o para o editar.') : null,
    form,
    !isNew ? historySection(base) : null,
  );

  dum().addEventListener('input', () => {
    updateComputed();
    const iso = parsePtDate(dum().value);
    if (dppAuto && iso) dpp().value = formatPtDate(defaultDpp(iso));
  });
  dpp().addEventListener('input', () => {
    const iso = parsePtDate(dum().value);
    dppAuto = !dpp().value.trim() || (!!iso && parsePtDate(dpp().value) === defaultDpp(iso));
  });
  updateComputed();
  initialSig = rawSig();
  inputs.get('Nome')!.focus();

  return {
    title,
    canLeave: () => saving || rawSig() === initialSig,
    update: () => {
      if (saving || isNew) return;
      const cur = c.record(recordId);
      if (!cur || contentSig(cur) === baseSig) return;
      if (rawSig() === initialSig) {
        // Nada por gravar: mostra a versão nova.
        ui.go(`#/registo/${encodeURIComponent(recordId)}`);
        return;
      }
      replace(
        remoteNotice,
        h(
          'div',
          { class: 'banner banner-warn', role: 'alert' },
          h('p', null, `Este registo foi alterado por ${cur.last.author} (${formatPtDateTime(cur.last.ts)}) enquanto o tinha aberto. Se gravar, alterações aos mesmos campos ficam marcadas como conflito para resolver.`),
        ),
      );
    },
  };
}
