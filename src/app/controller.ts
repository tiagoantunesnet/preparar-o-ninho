/**
 * Controlador da aplicação: deteção de capacidades, escolha de modo, leitura
 * periódica, merge, gravação de eventos e fila de pendentes. Sem DOM — a UI
 * subscreve o evento "change".
 */
import { todayIso } from '../core/dates';
import { eventFileName, eventRelPath, makeEvent, parseEventText, serializeEvent } from '../core/events';
import { HlcClock, maxHlc } from '../core/hlc';
import { newDeviceId } from '../core/ids';
import { emptyState, type MergeState, type RecordState } from '../core/merge';
import { buildViews, type RecordView } from '../core/records';
import { buildState, makeSnapshot, serializeSnapshot, snapshotFileName, type SnapshotFile } from '../core/snapshot';
import { DEFAULT_CONFIG, type AppConfig, type Change, type EventType, type RgEvent } from '../core/types';
import { makeZip } from '../core/zip';
import type { Capabilities } from '../storage/capabilities';
import { entriesFromPicked, type Downloader, type PickedFile } from '../storage/compat';
import { FsaBackend, listDataFiles, looksLikeAppFolder, type ProbeResult } from '../storage/fsa';
import { isDirHandle, type DirHandleLike } from '../storage/fsTypes';
import type { KV } from '../storage/kv';
import { PendingQueue, type PendingItem } from '../storage/pending';
import { errMsg, FolderReader, type FileEntry, type ScanResult } from '../storage/reader';

export type Mode = 'none' | 'full' | 'compat';

export const APP_VERSION = '1.0.0';
export const REFRESH_MS = 20_000;
export const ARCHIVE_AFTER_DAYS = 90;
const HANDLE_KEY = 'folderHandle';

export interface HandleStore {
  get(): Promise<unknown>;
  set(h: unknown): Promise<void>;
  clear(): Promise<void>;
}

export interface ControllerDeps {
  kv: KV;
  caps: Capabilities;
  handleStore: HandleStore | null;
  downloader: Downloader;
  pickDirectory: (() => Promise<DirHandleLike>) | null;
  now?: () => Date;
}

export type CommitResult =
  | { ok: true; how: 'folder'; path: string }
  | { ok: true; how: 'download'; path: string; persisted: boolean }
  | { ok: false; error: string };

export type PickOutcome =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'blocked' | 'not-app-folder' | 'error'; error?: string; handle?: DirHandleLike };

interface CompatSource {
  kind: 'files' | 'handle';
  entries?: FileEntry[];
  root?: DirHandleLike;
  name: string;
}

export class Controller extends EventTarget {
  readonly kv: KV;
  readonly caps: Capabilities;
  readonly deviceId: string;
  readonly pending: PendingQueue;
  readonly clock: HlcClock;
  private readonly now: () => Date;
  private readonly reader = new FolderReader();

  mode: Mode = 'none';
  author = '';
  full: FsaBackend | null = null;
  compat: CompatSource | null = null;
  folderName = '';
  probe: ProbeResult | null = null;
  pickerError: string | null = null;
  handlePersisted: boolean | null = null;
  storedHandle: DirHandleLike | null = null;

  scan: ScanResult | null = null;
  scanError: string | null = null;
  scanning = false;
  config: AppConfig = DEFAULT_CONFIG;
  state: MergeState = emptyState();
  views: RecordView[] = [];
  viewsById = new Map<string, RecordView>();
  pendingIds = new Set<string>();
  /** Eventos gravados nesta sessão ainda não vistos numa leitura. */
  private localWritten = new Map<string, RgEvent>();
  /** Marca "última visita" da sessão anterior (só um hlc, sem dados pessoais). */
  sinceMarker: string | null;
  lastConfirmed: PendingItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: ControllerDeps) {
    super();
    this.kv = deps.kv;
    this.caps = deps.caps;
    this.now = deps.now ?? (() => new Date());
    let dev = this.kv.get('deviceId');
    if (!dev) {
      dev = newDeviceId();
      this.kv.set('deviceId', dev);
    }
    this.deviceId = dev;
    this.author = this.kv.get('author') ?? '';
    this.pending = new PendingQueue(this.kv);
    this.clock = new HlcClock(() => this.now().getTime(), this.kv.get('hlc'));
    this.sinceMarker = this.kv.get('lastVisit');
  }

  private emit(): void {
    this.dispatchEvent(new Event('change'));
  }

  today(): string {
    return todayIso(this.now());
  }

  setAuthor(name: string): void {
    this.author = name.trim().slice(0, 80);
    this.kv.set('author', this.author);
    this.emit();
  }

  get canAutoRefresh(): boolean {
    return this.mode === 'full' || (this.mode === 'compat' && this.compat?.kind === 'handle');
  }

  // ---------------------------------------------------------------- arranque

  /** Tenta recuperar a pasta guardada. Não pede permissões (exige um clique). */
  async init(): Promise<void> {
    this.rebuild();
    if (!this.deps.handleStore || !this.caps.directoryPicker) return;
    let h: unknown;
    try {
      h = await this.deps.handleStore.get();
    } catch {
      this.handlePersisted = false;
      return;
    }
    if (!h) return;
    if (!isDirHandle(h)) {
      // Não foi possível guardar/restaurar o handle (p.ex. IndexedDB limitado).
      this.handlePersisted = false;
      return;
    }
    this.handlePersisted = true;
    this.storedHandle = h;
    let perm: string = 'prompt';
    try {
      perm = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';
    } catch {
      perm = 'prompt';
    }
    if (perm === 'granted') await this.connectHandle(h);
    else this.emit();
  }

  /** Clique em "Continuar com a pasta …": pede de novo a permissão. */
  async reconnectStored(): Promise<PickOutcome> {
    const h = this.storedHandle;
    if (!h) return { ok: false, reason: 'error', error: 'sem pasta guardada' };
    try {
      const perm = (await h.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (perm !== 'granted') {
        // Sem escrita: tenta só leitura (modo compatível com leitura automática).
        const r = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
        if (r !== 'granted') return { ok: false, reason: 'blocked', error: 'permissão recusada' };
      }
    } catch (e) {
      return { ok: false, reason: 'error', error: errMsg(e) };
    }
    await this.connectHandle(h);
    return { ok: true };
  }

  /** Clique em "Escolher pasta": File System Access API. */
  async pickFolderFull(): Promise<PickOutcome> {
    if (!this.deps.pickDirectory) return { ok: false, reason: 'blocked', error: 'API indisponível neste browser' };
    let h: DirHandleLike;
    try {
      h = await this.deps.pickDirectory();
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'AbortError') return { ok: false, reason: 'cancelled' };
      this.pickerError = errMsg(e);
      this.emit();
      return { ok: false, reason: 'blocked', error: this.pickerError };
    }
    if (!(await looksLikeAppFolder(h))) return { ok: false, reason: 'not-app-folder', handle: h };
    await this.adoptHandle(h);
    return { ok: true };
  }

  /** Usar a pasta mesmo que não pareça a RegistoGravidas (confirmado pelo utilizador). */
  async adoptHandle(h: DirHandleLike): Promise<void> {
    if (this.deps.handleStore) {
      try {
        await this.deps.handleStore.set(h);
        const back = await this.deps.handleStore.get();
        this.handlePersisted = isDirHandle(back);
      } catch {
        this.handlePersisted = false;
      }
    } else {
      this.handlePersisted = false;
    }
    this.storedHandle = h;
    await this.connectHandle(h);
  }

  private async connectHandle(h: DirHandleLike): Promise<void> {
    this.folderName = h.name;
    const backend = new FsaBackend(h);
    this.probe = await backend.probe(this.deviceId);
    this.reader.clear();
    if (this.probe.ok) {
      try {
        await backend.ensureStructure();
      } catch {
        /* a leitura seguinte mostrará o problema */
      }
      this.full = backend;
      this.compat = null;
      this.mode = 'full';
    } else {
      this.full = null;
      this.compat = { kind: 'handle', root: h, name: h.name };
      this.mode = 'compat';
    }
    await this.refresh();
    this.startTimer();
  }

  /** Modo compatível: ficheiros escolhidos com <input webkitdirectory>. */
  async useCompatFiles(files: ArrayLike<PickedFile>): Promise<{ ok: boolean; looksLikeAppFolder: boolean; rootName: string }> {
    const sum = entriesFromPicked(files);
    this.stopTimer();
    this.full = null;
    this.compat = { kind: 'files', entries: sum.entries, name: sum.rootName };
    this.folderName = sum.rootName;
    this.mode = 'compat';
    await this.refresh();
    return { ok: true, looksLikeAppFolder: sum.looksLikeAppFolder, rootName: sum.rootName };
  }

  private startTimer(): void {
    this.stopTimer();
    if (!this.canAutoRefresh) return;
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ leitura

  private inflightScan: Promise<void> | null = null;
  private rescanRequested = false;

  /**
   * Lê a pasta. Se já houver uma leitura em curso, agenda outra logo a seguir
   * (para não perder ficheiros que chegaram entretanto) e espera por ela.
   */
  async refresh(): Promise<void> {
    if (this.mode === 'none') return;
    if (this.inflightScan) {
      this.rescanRequested = true;
      return this.inflightScan;
    }
    this.inflightScan = (async () => {
      do {
        this.rescanRequested = false;
        await this.scanOnce();
      } while (this.rescanRequested && this.mode !== 'none');
    })();
    try {
      await this.inflightScan;
    } finally {
      this.inflightScan = null;
    }
  }

  private async scanOnce(): Promise<void> {
    this.scanning = true;
    this.emit();
    try {
      let entries: FileEntry[];
      if (this.mode === 'full' && this.full) entries = await this.full.listFiles();
      else if (this.compat?.kind === 'handle' && this.compat.root) entries = await listDataFiles(this.compat.root);
      else entries = this.compat?.entries ?? [];
      const scan = await this.reader.ingest(entries);
      this.scan = scan;
      this.scanError = null;
      this.config = scan.config;
      const found = new Set(scan.events.map((e) => e.id));
      for (const s of scan.snapshots) found.add(s.snapshot.id);
      for (const id of [...this.localWritten.keys()]) if (found.has(id)) this.localWritten.delete(id);
      this.lastConfirmed = this.pending.confirm(found);
      if (this.mode === 'full') await this.flushPendingToFolder(found);
    } catch (e) {
      this.scanError = errMsg(e);
    } finally {
      this.scanning = false;
    }
    this.rebuild();
    if (this.scan && !this.scanError && this.state.maxHlc) {
      this.kv.set('lastVisit', maxHlc(this.kv.get('lastVisit'), this.state.maxHlc)!);
    }
    this.emit();
  }

  /** Modo completo: grava diretamente na pasta os pendentes de descargas anteriores. */
  private async flushPendingToFolder(found: Set<string>): Promise<void> {
    if (!this.full) return;
    for (const item of this.pending.list()) {
      if (found.has(item.id) || item.kind !== 'event') continue;
      try {
        await this.full.writeEventText(item.relPath, item.text);
        this.pending.remove(item.id);
        const r = parseEventText(item.text);
        if (r.ok) this.localWritten.set(r.value.id, r.value);
      } catch {
        /* fica pendente */
      }
    }
  }

  private pendingEvents(): RgEvent[] {
    const out: RgEvent[] = [];
    this.pendingIds = new Set();
    for (const item of this.pending.list()) {
      if (item.kind !== 'event') continue;
      const r = parseEventText(item.text);
      if (r.ok) {
        out.push(r.value);
        this.pendingIds.add(r.value.id);
      }
    }
    return out;
  }

  rebuild(): void {
    const events = new Map<string, RgEvent>();
    for (const e of this.scan?.events ?? []) events.set(e.id, e);
    for (const e of this.localWritten.values()) events.set(e.id, e);
    for (const e of this.pendingEvents()) if (!events.has(e.id)) events.set(e.id, e);
    const snaps = (this.scan?.snapshots ?? []).map((s) => s.snapshot);
    this.state = buildState(snaps, events.values()).state;
    if (this.state.maxHlc) {
      this.clock.observe(this.state.maxHlc);
      this.kv.set('hlc', this.clock.current());
    }
    this.views = buildViews(this.state, this.today());
    this.viewsById = new Map(this.views.map((v) => [v.id, v]));
    this.dataSig = [this.state.eventIds.size, this.state.maxHlc, this.pendingIds.size, snaps.length, this.today(), JSON.stringify(this.config)].join('|');
  }

  private dataSig = '';

  /** Muda sempre que os dados mostrados mudam (para as vistas evitarem redesenhar à toa). */
  dataVersion(): string {
    return `${this.dataSig}|${this.sinceMarker ?? ''}`;
  }

  // ---------------------------------------------------------------- gravação

  /** Constrói (sem gravar) um evento local. */
  newEvent(type: EventType, recordId: string, changes: Record<string, Change>, baseRev: string | null): RgEvent {
    const hlc = this.clock.tick();
    this.kv.set('hlc', hlc);
    return makeEvent({ hlc, author: this.author || '(sem nome)', deviceId: this.deviceId, recordId, type, changes, baseRev, now: this.now() });
  }

  /**
   * Grava um evento. Em caso de erro devolve ok:false e NADA é perdido:
   * o chamador mantém o formulário e pode repetir (o mesmo evento) ou
   * optar por `commitByDownload`.
   */
  async commit(ev: RgEvent): Promise<CommitResult> {
    if (this.mode === 'full' && this.full) {
      try {
        const path = await this.full.writeEvent(ev);
        this.localWritten.set(ev.id, ev);
        this.rebuild();
        this.emit();
        void this.refresh();
        return { ok: true, how: 'folder', path };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    }
    if (this.mode === 'compat') return this.commitByDownload([ev]);
    return { ok: false, error: 'nenhuma pasta selecionada' };
  }

  /** Gravação por descarga (modo compatível, ou alternativa quando a escrita falha). */
  commitByDownload(events: RgEvent[]): CommitResult {
    const items: PendingItem[] = events.map((ev) => ({
      kind: 'event',
      id: ev.id,
      relPath: eventRelPath(ev),
      fileName: eventFileName(ev),
      text: serializeEvent(ev),
      createdAt: this.now().toISOString(),
      downloads: 1,
    }));
    const persisted = this.pending.addMany(items);
    try {
      this.downloadItems(items);
    } catch (e) {
      if (!persisted) return { ok: false, error: 'não foi possível descarregar nem guardar localmente: ' + errMsg(e) };
    }
    this.rebuild();
    this.emit();
    const path = items.length === 1 ? items[0].relPath : 'data/events';
    return { ok: true, how: 'download', path, persisted };
  }

  /** Grava vários eventos (importação). */
  async commitMany(events: RgEvent[]): Promise<{ written: number; failed: RgEvent[]; how: 'folder' | 'download'; error?: string; persisted?: boolean }> {
    if (this.mode === 'compat') {
      const r = this.commitByDownload(events);
      return { written: r.ok ? events.length : 0, failed: r.ok ? [] : events, how: 'download', error: r.ok ? undefined : r.error, persisted: r.ok && r.how === 'download' ? r.persisted : false };
    }
    const failed: RgEvent[] = [];
    let written = 0;
    let error: string | undefined;
    for (const ev of events) {
      if (!this.full) {
        failed.push(ev);
        continue;
      }
      try {
        await this.full.writeEvent(ev);
        this.localWritten.set(ev.id, ev);
        written++;
      } catch (e) {
        error = errMsg(e);
        failed.push(ev);
      }
    }
    this.rebuild();
    this.emit();
    void this.refresh();
    return { written, failed, how: 'folder', error };
  }

  /** Descarrega de novo itens pendentes (todos ou os indicados). */
  redownloadPending(ids?: string[]): void {
    const items = this.pending.list().filter((i) => i.kind === 'event' && (!ids || ids.includes(i.id)));
    if (!items.length) return;
    this.downloadItems(items);
    this.pending.markDownloaded(items.map((i) => i.id));
    this.emit();
  }

  private downloadItems(items: PendingItem[]): void {
    if (items.length === 1) {
      this.deps.downloader(items[0].fileName, new Blob([items[0].text], { type: 'application/json' }));
      return;
    }
    const enc = new TextEncoder();
    const zip = makeZip(items.map((i) => ({ path: i.relPath.replace(/^data\/events\//, ''), data: enc.encode(i.text) })), this.now());
    const stamp = this.now().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    this.deps.downloader(`eventos_${stamp}_${this.deviceId}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
  }

  // ------------------------------------------------------------- snapshots

  /** Estado só com o que está confirmado na pasta (sem pendentes). */
  private confirmedState(): MergeState {
    const events = new Map<string, RgEvent>();
    for (const e of this.scan?.events ?? []) events.set(e.id, e);
    for (const e of this.localWritten.values()) events.set(e.id, e);
    return buildState((this.scan?.snapshots ?? []).map((s) => s.snapshot), events.values()).state;
  }

  async consolidate(): Promise<{ ok: true; how: 'folder' | 'download'; path: string; snapshot: SnapshotFile } | { ok: false; error: string }> {
    if (this.mode === 'none') return { ok: false, error: 'nenhuma pasta selecionada' };
    await this.refresh();
    const snap = makeSnapshot(this.confirmedState(), { hlc: this.clock.tick(), author: this.author, deviceId: this.deviceId, now: this.now() });
    if (this.mode === 'full' && this.full) {
      try {
        const path = await this.full.writeSnapshot(snap);
        await this.refresh();
        return { ok: true, how: 'folder', path, snapshot: snap };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    }
    try {
      this.deps.downloader(snapshotFileName(snap), new Blob([serializeSnapshot(snap)], { type: 'application/json' }));
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    return { ok: true, how: 'download', path: `data/snapshots/${snapshotFileName(snap)}`, snapshot: snap };
  }

  /** Eventos que podem ir para data/archive: incluídos num snapshot com mais de 90 dias. */
  archiveCandidates(): string[] {
    if (!this.scan) return [];
    const limit = this.now().getTime() - ARCHIVE_AFTER_DAYS * 86_400_000;
    const ids = new Set<string>();
    for (const { snapshot } of this.scan.snapshots) {
      if (Date.parse(snapshot.ts) < limit) for (const id of snapshot.eventIds) ids.add(id);
    }
    const paths: string[] = [];
    for (const [id, path] of this.scan.eventPaths) if (ids.has(id)) paths.push(path);
    return paths.sort();
  }

  async archiveOld(): Promise<{ moved: number; failed: { path: string; error: string }[] }> {
    if (this.mode !== 'full' || !this.full) return { moved: 0, failed: [{ path: '', error: 'só disponível no modo completo' }] };
    const r = await this.full.archiveEvents(this.archiveCandidates());
    await this.refresh();
    return r;
  }

  // -------------------------------------------------------------- utilidades

  record(id: string): RecordView | undefined {
    return this.viewsById.get(id);
  }

  recordState(id: string): RecordState | undefined {
    return this.state.records[id];
  }

  /** "novo" / "alterado" desde a última visita (alterações de outros dispositivos). */
  changeMark(v: RecordView): 'novo' | 'alterado' | null {
    const m = this.sinceMarker;
    if (!m) return null;
    if (v.created && v.created.hlc > m && v.created.deviceId !== this.deviceId) return 'novo';
    if (v.rev > m && v.state.history.some((h) => h.hlc > m && h.deviceId !== this.deviceId)) return 'alterado';
    return null;
  }

  markAllSeen(): void {
    this.sinceMarker = this.state.maxHlc;
    if (this.state.maxHlc) this.kv.set('lastVisit', this.state.maxHlc);
    this.emit();
  }

  forgetFolder(): void {
    this.stopTimer();
    void this.deps.handleStore?.clear();
    this.storedHandle = null;
    this.full = null;
    this.compat = null;
    this.mode = 'none';
    this.scan = null;
    this.reader.clear();
    this.rebuild();
    this.emit();
  }
}

export function idbHandleStore(get: (k: string) => Promise<unknown>, set: (k: string, v: unknown) => Promise<void>, del: (k: string) => Promise<void>): HandleStore {
  return {
    get: () => get(HANDLE_KEY),
    set: (h) => set(HANDLE_KEY, h),
    clear: () => del(HANDLE_KEY),
  };
}
