import type { CommitResult, Controller } from '../app/controller';
import { formatPtDateTime } from '../core/dates';
import type { RgEvent } from '../core/types';
import type { PickedFile } from '../storage/compat';
import { h, plural, replace } from './dom';
import { consolidateView } from './views/consolidate';
import { contactView } from './views/contact';
import { diagnosticsView } from './views/diagnostics';
import { importView } from './views/import';
import { listView } from './views/list';
import { recentView } from './views/recent';
import { recordView } from './views/record';
import { setupView, userView } from './views/setup';

export interface View {
  title: string;
  /** Re-render automático quando chegam dados novos. */
  update?(): void;
  /** Pode sair? (alterações por gravar) */
  canLeave?(): boolean;
  dispose?(): void;
}

type ViewFactory = (ui: UI, main: HTMLElement, param: string) => View;

const ROUTES: Record<string, { label: string; factory: ViewFactory; nav: boolean }> = {
  registos: { label: 'Registos', factory: listView, nav: true },
  'a-contactar': { label: 'A contactar', factory: contactView, nav: true },
  recentes: { label: 'Alterações recentes', factory: recentView, nav: true },
  importar: { label: 'Importar Excel', factory: importView, nav: true },
  consolidar: { label: 'Consolidar', factory: consolidateView, nav: true },
  diagnostico: { label: 'Diagnóstico', factory: diagnosticsView, nav: true },
  registo: { label: 'Registo', factory: recordView, nav: false },
  nova: { label: 'Nova grávida', factory: recordView, nav: false },
  inicio: { label: 'Primeira utilização', factory: setupView, nav: false },
  utilizador: { label: 'Utilizador', factory: userView, nav: false },
};

export class UI {
  readonly main: HTMLElement;
  private header!: HTMLElement;
  private statusEl!: HTMLElement;
  private navEl!: HTMLElement;
  private bannersEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private dialogEl!: HTMLDialogElement;
  private compatInput!: HTMLInputElement;
  private modeEl = h('span', { class: 'mode', 'data-testid': 'mode' });
  private modeHelpEl = h('span', { class: 'mode-help' });
  private lastEl = h('strong', { 'data-testid': 'last-update' });
  private refreshBtn = h('button', { type: 'button', class: 'btn btn-small', onclick: () => this.refreshClicked() }, 'Atualizar');
  private userNameEl = h('strong');
  private navKey = '';
  private bannersKey = '';
  private current: View | null = null;
  private routed = false;
  private currentRoute = '';
  private lastHash = '';

  constructor(
    readonly ctl: Controller,
    private root: HTMLElement,
  ) {
    this.main = h('main', { id: 'conteudo', tabindex: '-1' });
  }

  start(): void {
    this.compatInput = h('input', {
      type: 'file',
      id: 'compat-folder-input',
      webkitdirectory: true,
      multiple: true,
      class: 'visually-hidden',
      tabindex: '-1',
      'aria-hidden': 'true',
      onchange: () => void this.onCompatFiles(),
    });
    this.statusEl = h(
      'div',
      { class: 'status' },
      this.modeEl,
      this.modeHelpEl,
      h('span', { class: 'last-update' }, 'Última atualização: ', this.lastEl),
      this.refreshBtn,
      h('span', { class: 'user' }, 'Utilizador: ', this.userNameEl, ' ', h('a', { href: '#/utilizador' }, 'alterar')),
    );
    this.navEl = h('nav', { 'aria-label': 'Principal', class: 'nav' });
    this.header = h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('h1', null, 'Registo de Grávidas'), h('a', { href: 'LEIA-ME.html', target: '_blank', rel: 'noopener', class: 'help-link' }, 'Ajuda (LEIA-ME)')),
      this.statusEl,
      this.navEl,
    );
    this.bannersEl = h('div', { class: 'banners' });
    this.toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.dialogEl = h('dialog', { class: 'dialog', 'aria-modal': 'true' });
    replace(
      this.root,
      h('a', { href: '#conteudo', class: 'skip-link', onclick: (e: Event) => { e.preventDefault(); this.main.focus(); } }, 'Saltar para o conteúdo'),
      this.header,
      this.bannersEl,
      this.main,
      this.toastEl,
      this.dialogEl,
      this.compatInput,
    );

    this.ctl.addEventListener('change', () => this.onChange());
    window.addEventListener('hashchange', () => this.route());
    window.addEventListener('focus', () => {
      if (this.ctl.canAutoRefresh) void this.ctl.refresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.ctl.canAutoRefresh) void this.ctl.refresh();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.current?.canLeave && !this.current.canLeave()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.renderChrome();
    this.route();
  }

  // ---------------------------------------------------------------- routing

  needsSetup(): boolean {
    return !this.ctl.author || this.ctl.mode === 'none';
  }

  go(hash: string): void {
    if (location.hash === hash) this.route(true);
    else location.hash = hash;
  }

  private route(force = false): void {
    const raw = location.hash.replace(/^#\/?/, '');
    let [name, ...rest] = raw.split('/');
    const param = decodeURIComponent(rest.join('/'));
    if (!ROUTES[name]) name = 'registos';
    if (this.needsSetup() && name !== 'diagnostico' && name !== 'utilizador') name = 'inicio';
    if (!this.needsSetup() && name === 'inicio') name = 'registos';
    const key = `${name}/${param}`;
    if (!force && key === this.currentRoute) return;
    if (this.current?.canLeave && !this.current.canLeave()) {
      if (!window.confirm('Tem alterações por gravar. Sair mesmo assim? (as alterações perdem-se)')) {
        history.replaceState(null, '', this.lastHash || '#/registos');
        return;
      }
    }
    this.current?.dispose?.();
    this.currentRoute = key;
    this.lastHash = location.hash;
    replace(this.main);
    const r = ROUTES[name];
    this.current = r.factory(this, this.main, name === 'nova' ? '' : param);
    document.title = `${this.current.title} — Registo de Grávidas`;
    this.renderNav(name);
    // No arranque deixa-se o foco no início da página (link "Saltar para o conteúdo");
    // nas navegações seguintes move-se para o conteúdo novo.
    if (this.routed) this.main.focus({ preventScroll: true });
    this.routed = true;
    window.scrollTo(0, 0);
  }

  private onChange(): void {
    this.renderChrome();
    if (this.currentRoute.startsWith('inicio/') && !this.needsSetup()) {
      this.go('#/registos');
      return;
    }
    this.current?.update?.();
  }

  // ----------------------------------------------------------------- chrome

  /** Atualiza o cabeçalho no lugar (sem recriar elementos, para não perder o foco). */
  private renderChrome(): void {
    const c = this.ctl;
    const modeText = c.mode === 'full' ? 'Modo completo' : c.mode === 'compat' ? 'Modo compatível' : 'Sem pasta';
    const modeHelp =
      c.mode === 'full'
        ? 'lê e grava diretamente na pasta'
        : c.mode === 'compat'
          ? c.compat?.kind === 'handle'
            ? 'leitura automática; gravação por descarga de ficheiros'
            : 'leitura por seleção da pasta; gravação por descarga de ficheiros'
          : 'escolha a pasta RegistoGravidas';
    const last = c.scanning ? 'a ler a pasta…' : c.scan ? formatPtDateTime(c.scan.at.toISOString(), true) : '—';
    this.modeEl.textContent = modeText;
    this.modeEl.className = `mode mode-${c.mode}`;
    this.modeHelpEl.textContent = modeHelp;
    this.lastEl.textContent = last;
    this.refreshBtn.hidden = c.mode === 'none';
    this.refreshBtn.setAttribute('aria-busy', String(c.scanning));
    this.userNameEl.textContent = c.author || '—';
    this.renderBanners();
  }

  private renderNav(active: string): void {
    const conflicts = this.ctl.views.filter((v) => v.conflicts.length).length;
    const key = `${active}|${conflicts}|${this.needsSetup()}`;
    if (key === this.navKey) return;
    this.navKey = key;
    const items = Object.entries(ROUTES)
      .filter(([, r]) => r.nav)
      .map(([k, r]) => {
        const n = k === 'registos' ? conflicts : 0;
        return h(
          'li',
          null,
          h('a', { href: `#/${k}`, 'aria-current': k === active ? 'page' : undefined, class: k === active ? 'active' : '' }, r.label, n ? h('span', { class: 'badge badge-conflict', 'aria-label': `${n} com conflito` }, String(n)) : null),
        );
      });
    replace(this.navEl, this.needsSetup() ? null : h('ul', null, items));
  }

  private renderBanners(): void {
    const c = this.ctl;
    if (c.lastConfirmed.length) {
      this.toast(`${plural(c.lastConfirmed.length, 'ficheiro confirmado', 'ficheiros confirmados')} na pasta.`);
      c.lastConfirmed = [];
    }
    this.renderNav(this.currentRoute.split('/')[0]);
    const pendingList = c.pending.list();
    const key = JSON.stringify([c.mode, c.storedHandle?.name, c.author, c.scanError, c.scan?.configError, c.probe, c.folderName, pendingList.map((p) => [p.id, p.downloads])]);
    if (key === this.bannersKey) return;
    this.bannersKey = key;
    const out: HTMLElement[] = [];
    if (c.mode === 'none' && c.storedHandle && c.author) {
      out.push(
        h(
          'div',
          { class: 'banner banner-info' },
          h('p', null, `Para continuar, autorize de novo o acesso à pasta «${c.storedHandle.name}».`),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void this.reconnect() }, `Continuar com a pasta «${c.storedHandle.name}»`),
        ),
      );
    }
    if (c.scanError) out.push(h('div', { class: 'banner banner-error', role: 'alert' }, h('p', null, 'Erro ao ler a pasta: ' + c.scanError), h('p', null, 'Os dados já introduzidos não se perderam. Tente "Atualizar"; se persistir, veja o ecrã Diagnóstico.')));
    if (c.scan?.configError) out.push(h('div', { class: 'banner banner-warn' }, `data/config.json: ${c.scan.configError}. A usar as listas por omissão.`));
    if (c.mode === 'compat' && c.probe && !c.probe.ok) {
      out.push(h('div', { class: 'banner banner-warn' }, h('p', null, 'Não é possível gravar diretamente na pasta (', c.probe.error ?? 'escrita recusada', '). Cada gravação descarrega um ficheiro que tem de mover para a pasta indicada.')));
    }
    const pend = pendingList.filter((i) => i.kind === 'event');
    if (pend.length) {
      const folder = c.folderName || 'RegistoGravidas';
      const dirs = [...new Set(pend.map((p) => p.relPath.split('/').slice(0, -1).join('\\')))];
      out.push(
        h(
          'div',
          { class: 'banner banner-warn', 'data-testid': 'pending-banner' },
          h('p', null, h('strong', null, plural(pend.length, 'alteração ainda não confirmada', 'alterações ainda não confirmadas')), ' na pasta partilhada.'),
          h('p', null, 'Mova os ficheiros descarregados (pasta Transferências) para ', ...dirs.map((d, i) => [i ? ' ou ' : '', h('code', null, `${folder}\\${d}\\`)]), ' e depois carregue em "Atualizar".'),
          h(
            'details',
            null,
            h('summary', null, 'Ver ficheiros pendentes'),
            h('ul', null, pend.map((p) => h('li', null, h('code', null, p.fileName), ` — criado ${formatPtDateTime(p.createdAt)}`, ' ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => c.redownloadPending([p.id]) }, 'Descarregar de novo')))),
          ),
          pend.length > 1 ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => c.redownloadPending() }, 'Descarregar todos (ZIP)') : null,
        ),
      );
    }
    replace(this.bannersEl, out);
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout((this.toastEl as unknown as { _t?: number })._t);
    (this.toastEl as unknown as { _t?: number })._t = window.setTimeout(() => this.toastEl.classList.remove('show'), 6000);
  }

  // ----------------------------------------------------------------- pasta

  refreshClicked(): void {
    if (this.ctl.mode === 'compat' && this.ctl.compat?.kind === 'files') this.openCompatPicker();
    else void this.ctl.refresh();
  }

  openCompatPicker(): void {
    this.compatInput.value = '';
    this.compatInput.click();
  }

  private async onCompatFiles(): Promise<void> {
    const files = this.compatInput.files;
    if (!files || files.length === 0) return;
    const r = await this.ctl.useCompatFiles(files as unknown as ArrayLike<PickedFile>);
    if (!r.looksLikeAppFolder) this.toast(`A pasta «${r.rootName}» não parece ser a RegistoGravidas (não tem data\\events). Confirme a pasta escolhida.`);
    else this.toast(`Pasta lida: ${plural(this.ctl.scan?.eventFiles ?? 0, 'ficheiro de evento', 'ficheiros de eventos')}.`);
  }

  async reconnect(): Promise<void> {
    const r = await this.ctl.reconnectStored();
    if (!r.ok) this.toast('Não foi possível aceder à pasta: ' + (r.error ?? r.reason) + '. Escolha a pasta de novo.');
  }

  // --------------------------------------------------------------- gravação

  /**
   * Grava um evento e, se falhar, pergunta o que fazer sem perder nada.
   * Devolve o resultado final, ou null se o utilizador cancelou (o formulário mantém-se).
   */
  async commitWithFallback(ev: RgEvent): Promise<CommitResult | null> {
    for (;;) {
      const r = await this.ctl.commit(ev);
      if (r.ok) {
        if (r.how === 'download') this.showDownloadInstructions([r.path], r.persisted);
        return r;
      }
      const choice = await this.askOnFailure(r.error);
      if (choice === 'retry') continue;
      if (choice === 'download') {
        const d = this.ctl.commitByDownload([ev]);
        if (d.ok && d.how === 'download') this.showDownloadInstructions([d.path], d.persisted);
        return d;
      }
      return null;
    }
  }

  private askOnFailure(error: string): Promise<'retry' | 'download' | 'cancel'> {
    return new Promise((resolve) => {
      const done = (v: 'retry' | 'download' | 'cancel') => {
        this.dialogEl.close();
        resolve(v);
      };
      const titleId = 'dlg-fail-title';
      this.dialogEl.setAttribute('aria-labelledby', titleId);
      replace(
        this.dialogEl,
        h('h2', { id: titleId }, 'Não foi possível gravar na pasta'),
        h('p', null, 'Erro: ', h('code', null, error)),
        h('p', null, h('strong', null, 'A alteração não foi perdida.'), ' Pode tentar de novo (p.ex. depois de o OneDrive terminar de sincronizar) ou guardar por descarga: o ficheiro vai para Transferências e terá de o mover para a pasta data\\events.'),
        h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => done('retry') }, 'Tentar de novo'),
          h('button', { type: 'button', class: 'btn', onclick: () => done('download') }, 'Guardar por descarga'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => done('cancel') }, 'Cancelar (manter o formulário)'),
        ),
      );
      this.dialogEl.onclose = () => resolve('cancel');
      this.dialogEl.showModal();
    });
  }

  showDownloadInstructions(paths: string[], persisted: boolean, zip = false): void {
    const folder = this.ctl.folderName || 'RegistoGravidas';
    const dirs = [...new Set(paths.map((p) => (p.endsWith('.json') ? p.split('/').slice(0, -1).join('\\') : p.replace(/\//g, '\\'))))];
    const titleId = 'dlg-dl-title';
    this.dialogEl.setAttribute('aria-labelledby', titleId);
    replace(
      this.dialogEl,
      h('h2', { id: titleId }, 'Ficheiro descarregado — falta um passo'),
      zip
        ? h('p', null, 'Foi descarregado um ficheiro ZIP. Abra-o, escolha "Extrair tudo" e extraia o conteúdo para:')
        : h('p', null, 'O ficheiro foi para a pasta Transferências. Mova-o para:'),
      h('p', { class: 'path' }, ...dirs.map((d) => h('code', { 'data-testid': 'target-path' }, `${folder}\\${d}\\`))),
      h('p', null, 'Qualquer subpasta dentro de ', h('code', null, `${folder}\\data\\events\\`), ' também serve. Depois carregue em "Atualizar" para confirmar.'),
      persisted
        ? h('p', null, 'Até ser encontrado na pasta, fica uma cópia neste PC e um aviso de "alterações não confirmadas".')
        : h('p', { class: 'error' }, h('strong', null, 'Atenção: '), 'não foi possível guardar uma cópia local neste browser. Não feche a aplicação antes de mover o ficheiro.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.dialogEl.close() }, 'Percebi')),
    );
    this.dialogEl.onclose = null;
    if (!this.dialogEl.open) this.dialogEl.showModal();
  }

  confirmDialog(title: string, body: string, okLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const titleId = 'dlg-confirm-title';
      this.dialogEl.setAttribute('aria-labelledby', titleId);
      const done = (v: boolean) => {
        this.dialogEl.onclose = null;
        this.dialogEl.close();
        resolve(v);
      };
      replace(
        this.dialogEl,
        h('h2', { id: titleId }, title),
        h('p', null, body),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => done(true) }, okLabel), h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => done(false) }, 'Cancelar')),
      );
      this.dialogEl.onclose = () => resolve(false);
      this.dialogEl.showModal();
    });
  }
}
