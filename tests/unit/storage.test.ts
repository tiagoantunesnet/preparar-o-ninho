import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type ControllerDeps } from '../../src/app/controller';
import { eventRelPath, makeEvent, serializeEvent } from '../../src/core/events';
import { formatHlc } from '../../src/core/hlc';
import type { Capabilities } from '../../src/storage/capabilities';
import { entriesFromPicked, toAppRelPath } from '../../src/storage/compat';
import { FsaBackend, writeProbe } from '../../src/storage/fsa';
import type { KV } from '../../src/storage/kv';
import { FolderReader } from '../../src/storage/reader';
import { memRoot, type MemDir } from '../helpers/memfs';

class TestKV implements KV {
  readonly persistent = true;
  m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
    return true;
  }
  remove(k: string) {
    this.m.delete(k);
  }
}

const caps = (directoryPicker = true): Capabilities => ({
  browser: 'teste',
  userAgent: 'vitest',
  protocol: 'file:',
  secureContext: true,
  directoryPicker,
  webkitdirectory: true,
  indexedDB: true,
  localStorage: true,
});

interface Download {
  name: string;
  data: Blob;
}

const controllers: Controller[] = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.stopTimer());
});

function makeCtl(opts: { root?: MemDir; author: string; directoryPicker?: boolean; now?: () => Date; kv?: TestKV }) {
  const downloads: Download[] = [];
  let stored: unknown = undefined;
  const deps: ControllerDeps = {
    kv: opts.kv ?? new TestKV(),
    caps: caps(opts.directoryPicker ?? true),
    handleStore: { get: async () => stored, set: async (h) => void (stored = h), clear: async () => void (stored = undefined) },
    downloader: (name, data) => downloads.push({ name, data }),
    pickDirectory: opts.root ? async () => opts.root! : null,
    now: opts.now,
  };
  const ctl = new Controller(deps);
  ctl.setAuthor(opts.author);
  controllers.push(ctl);
  return { ctl, downloads, deps };
}

function sampleEvent(recordId = 'r1', ms = Date.UTC(2026, 9, 3, 10)) {
  return makeEvent({
    hlc: formatHlc({ ms, c: 0 }),
    author: 'Externa',
    deviceId: 'pcext',
    recordId,
    type: 'create',
    changes: { Nome: { from: null, to: 'Fictícia Externa' }, DUM: { from: null, to: '2026-03-01' } },
    baseRev: null,
    now: new Date(ms),
  });
}

describe('FsaBackend (mock da File System Access API)', () => {
  it('teste de escrita: cria e apaga data/.probe/<deviceId>; falha numa pasta só de leitura', async () => {
    const root = memRoot();
    expect(await writeProbe(root, 'pcx')).toEqual({ ok: true });
    expect(root.listFiles()).toEqual([]);
    const ro = memRoot('RO', { readOnly: true });
    const r = await writeProbe(ro, 'pcx');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NotAllowedError/);
  });

  it('grava eventos em data/events/AAAA/MM e nunca sobrepõe um ficheiro diferente', async () => {
    const root = memRoot();
    const b = new FsaBackend(root);
    const ev = sampleEvent();
    const path = await b.writeEvent(ev);
    expect(path).toBe(eventRelPath(ev));
    expect(root.readText(path)).toBe(serializeEvent(ev));
    // repetir a mesma gravação é idempotente
    await expect(b.writeEvent(ev)).resolves.toBe(path);
    // um ficheiro diferente com o mesmo nome nunca é sobreposto
    root.putFile(path, 'outro conteúdo');
    await expect(b.writeEvent(ev)).rejects.toThrow(/já existe um ficheiro diferente/);
    expect(root.readText(path)).toBe('outro conteúdo');
  });

  it('leitura ignora .crswap, temporários, ocultos e corrompidos; tenta de novo na leitura seguinte', async () => {
    const root = memRoot();
    const ev = sampleEvent();
    const path = eventRelPath(ev);
    const text = serializeEvent(ev);
    root.putFile(path + '.crswap', text);
    root.putFile('data/events/2026/10/x.tmp', 'lixo');
    root.putFile('data/events/2026/10/.hidden.json', '{}');
    root.putFile('data/events/2026/10/~$lock.json', '{}');
    root.putFile('data/events/notas.txt', 'ola');
    const partial = root.putFile(path, text.slice(0, 30)); // a meio da sincronização
    root.putFile('data/archive/events/2026/01/velho.json', text); // nunca lido
    const reader = new FolderReader();
    const b = new FsaBackend(root);
    const s1 = await reader.ingest(await b.listFiles());
    expect(s1.events).toHaveLength(0);
    expect(s1.ignored.map((i) => i.reason).join('\n')).toMatch(/crswap[\s\S]*tmp|tmp[\s\S]*crswap/);
    expect(s1.ignored.find((i) => i.path === path)?.reason).toMatch(/incompleto/);
    expect(s1.ignored.some((i) => i.path.includes('archive'))).toBe(false);
    // o OneDrive termina a sincronização
    partial.data = new TextEncoder().encode(text);
    const s2 = await reader.ingest(await b.listFiles());
    expect(s2.events.map((e) => e.id)).toEqual([ev.id]);
  });

  it('cache por nome de ficheiro: a segunda leitura não volta a abrir ficheiros já lidos', async () => {
    const root = memRoot();
    const b = new FsaBackend(root);
    for (let i = 0; i < 5; i++) await b.writeEvent(sampleEvent(`r${i}`, Date.UTC(2026, 9, 3, 10, i)));
    const reader = new FolderReader();
    await reader.ingest(await b.listFiles());
    const before = root.opts.getFileCalls;
    const s = await reader.ingest(await b.listFiles());
    expect(root.opts.getFileCalls).toBe(before);
    expect(s.newlyRead).toBe(0);
    expect(s.events).toHaveLength(5);
  });

  it('cópias de conflito do OneDrive (mesmo evento, outro nome) contam como duplicado', async () => {
    const root = memRoot();
    const ev = sampleEvent();
    root.putFile(eventRelPath(ev), serializeEvent(ev));
    root.putFile(eventRelPath(ev).replace('.json', '-DESKTOP-PC2.json'), serializeEvent(ev));
    const s = await new FolderReader().ingest(await new FsaBackend(root).listFiles());
    expect(s.events).toHaveLength(1);
    expect(s.duplicateFiles).toBe(1);
  });

  it('arquivo: copia para data/archive, verifica e só depois remove o original', async () => {
    const root = memRoot();
    const b = new FsaBackend(root);
    const ev = sampleEvent();
    const p = await b.writeEvent(ev);
    const r = await b.archiveEvents([p]);
    expect(r).toEqual({ moved: 1, failed: [] });
    expect(root.readText(p)).toBeNull();
    expect(root.readText(p.replace('data/events/', 'data/archive/events/'))).toBe(serializeEvent(ev));
  });
});

describe('Controller — modo completo', () => {
  it('deteta capacidades: API + escrita OK → modo completo; cria estrutura e config.json', async () => {
    const root = memRoot();
    const { ctl } = makeCtl({ root, author: 'Ana' });
    expect((await ctl.pickFolderFull()).ok).toBe(false); // pasta vazia não parece a RegistoGravidas
    root.putFile('index.html', '<html>');
    expect(await ctl.pickFolderFull()).toEqual({ ok: true });
    expect(ctl.mode).toBe('full');
    expect(ctl.probe).toEqual({ ok: true });
    expect(ctl.handlePersisted).toBe(true);
    expect(root.readText('data/config.json')).toContain('UCSP Loures');
    expect(root.listFiles().some((f) => f.includes('.probe/'))).toBe(false);
  });

  it('API presente mas escrita recusada → modo compatível com leitura pelo handle', async () => {
    const root = memRoot('RegistoGravidas', { readOnly: true });
    root.putFile('index.html', '<html>');
    root.putFile(eventRelPath(sampleEvent()), serializeEvent(sampleEvent()));
    const { ctl, downloads } = makeCtl({ root, author: 'Ana' });
    await ctl.pickFolderFull();
    expect(ctl.mode).toBe('compat');
    expect(ctl.compat?.kind).toBe('handle');
    expect(ctl.canAutoRefresh).toBe(true);
    expect(ctl.views).toHaveLength(1);
    const ev = ctl.newEvent('create', 'novo', { Nome: { from: null, to: 'Teste' }, DUM: { from: null, to: '2026-05-01' } }, null);
    const r = await ctl.commit(ev);
    expect(r).toMatchObject({ ok: true, how: 'download', persisted: true });
    expect(downloads.map((d) => d.name)).toEqual([eventRelPath(ev).split('/').pop()]);
  });

  it('dois PCs em concorrência sobre a mesma pasta: conflito detetado e resolvido', async () => {
    const root = memRoot();
    root.putFile('index.html', '<html>');
    let t = Date.UTC(2026, 9, 3, 9);
    const now = () => new Date(t);
    const A = makeCtl({ root, author: 'Ana', now }).ctl;
    const B = makeCtl({ root, author: 'Bruno', now: () => new Date(t - 10 * 60_000) }).ctl; // relógio 10 min atrasado
    await A.pickFolderFull();
    await B.pickFolderFull();
    expect(A.deviceId).not.toBe(B.deviceId);

    const create = A.newEvent('create', 'r1', { Nome: { from: null, to: 'Fictícia' }, DUM: { from: null, to: '2026-03-07' }, Estado: { from: null, to: 'Ativa' } }, null);
    expect(await A.commit(create)).toMatchObject({ ok: true, how: 'folder' });
    t += 1000;
    await B.refresh();
    expect(B.record('r1')?.values.Nome).toBe('Fictícia');

    // ambos editam o telefone sem ver o outro
    const rA = A.record('r1')!.rev;
    const rB = B.record('r1')!.rev;
    expect(rA).toBe(rB);
    t += 1000;
    await A.commit(A.newEvent('update', 'r1', { Telefone: { from: '', to: '911111111' } }, rA));
    await B.commit(B.newEvent('update', 'r1', { Telefone: { from: '', to: '922222222' } }, rB));
    await A.refresh();
    await B.refresh();
    expect(A.record('r1')!.conflicts).toEqual(['Telefone']);
    expect(B.record('r1')!.conflicts).toEqual(['Telefone']);
    expect(A.record('r1')!.values.Telefone).toBe(B.record('r1')!.values.Telefone);

    // B (relógio atrasado) resolve; a resolução ganha porque viu ambos (HLC)
    const cur = B.record('r1')!;
    await B.commit(B.newEvent('resolve', 'r1', { Telefone: { from: cur.values.Telefone, to: '911111111' } }, cur.rev));
    await A.refresh();
    expect(A.record('r1')!.conflicts).toEqual([]);
    expect(A.record('r1')!.values.Telefone).toBe('911111111');
    expect(A.changeMark(A.record('r1')!)).toBeNull(); // sem marca na 1.ª sessão
  });

  it('erro de I/O ao gravar: nada muda e nada se perde; alternativa por descarga fica pendente e é gravada depois', async () => {
    const root = memRoot();
    root.putFile('index.html', '<html>');
    const { ctl, downloads } = makeCtl({ root, author: 'Ana' });
    await ctl.pickFolderFull();
    const ev = ctl.newEvent('create', 'r9', { Nome: { from: null, to: 'Teste IO' }, DUM: { from: null, to: '2026-05-01' } }, null);
    root.opts.failNextWrite = true;
    const r = await ctl.commit(ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/QuotaExceeded|falha/);
    expect(ctl.record('r9')).toBeUndefined();
    expect(root.listFiles().filter((f) => f.startsWith('data/events/'))).toEqual([]); // sem restos vazios
    // o utilizador escolhe "Guardar por descarga"
    const d = ctl.commitByDownload([ev]);
    expect(d).toMatchObject({ ok: true, how: 'download', persisted: true });
    expect(downloads).toHaveLength(1);
    expect(ctl.pending.list()).toHaveLength(1);
    expect(ctl.record('r9')?.values.Nome).toBe('Teste IO'); // visível como pendente
    // na leitura seguinte (modo completo) o pendente é gravado diretamente
    await ctl.refresh();
    expect(root.readText(eventRelPath(ev))).toBe(serializeEvent(ev));
    await ctl.refresh();
    expect(ctl.pending.list()).toHaveLength(0);
  });

  it('a pasta guardada é reutilizada; se a permissão estiver em "prompt" pede um clique', async () => {
    const root = memRoot('RegistoGravidas');
    root.putFile('index.html', '<html>');
    const kv = new TestKV();
    const first = makeCtl({ root, author: 'Ana', kv });
    await first.ctl.pickFolderFull();
    first.ctl.stopTimer();
    // nova sessão, mesmo PC
    root.opts.permission = 'prompt';
    const stored = await first.deps.handleStore!.get();
    const second = makeCtl({ root, author: 'Ana', kv });
    second.deps.handleStore!.set(stored);
    await second.ctl.init();
    expect(second.ctl.mode).toBe('none');
    expect(second.ctl.storedHandle?.name).toBe('RegistoGravidas');
    expect(await second.ctl.reconnectStored()).toEqual({ ok: true });
    expect(second.ctl.mode).toBe('full');
    expect(second.ctl.deviceId).toBe(first.ctl.deviceId);
  });

  it('handle não persistível (IndexedDB devolve objeto sem métodos) → pede a pasta em cada sessão', async () => {
    const { ctl, deps } = makeCtl({ author: 'Ana' });
    await deps.handleStore!.set({ kind: 'directory', name: 'x' });
    await ctl.init();
    expect(ctl.handlePersisted).toBe(false);
    expect(ctl.mode).toBe('none');
  });

  it('consolidar grava snapshot; arquivar só eventos de snapshots com mais de 90 dias', async () => {
    const root = memRoot();
    root.putFile('index.html', '<html>');
    let t = Date.UTC(2026, 0, 10);
    const { ctl } = makeCtl({ root, author: 'Ana', now: () => new Date(t) });
    await ctl.pickFolderFull();
    for (let i = 0; i < 3; i++) await ctl.commit(ctl.newEvent('create', `r${i}`, { Nome: { from: null, to: `F${i}` }, DUM: { from: null, to: '2026-01-01' } }, null));
    const s = await ctl.consolidate();
    expect(s.ok && s.how).toBe('folder');
    expect(ctl.scan!.snapshots).toHaveLength(1);
    expect(ctl.archiveCandidates()).toHaveLength(0);
    t += 91 * 86_400_000;
    await ctl.commit(ctl.newEvent('update', 'r0', { Telefone: { from: '', to: '912345678' } }, ctl.record('r0')!.rev));
    expect(ctl.archiveCandidates()).toHaveLength(3);
    const before = JSON.stringify(ctl.views.map((v) => v.values));
    const r = await ctl.archiveOld();
    expect(r.moved).toBe(3);
    expect(root.listFiles().filter((f) => f.startsWith('data/archive/'))).toHaveLength(3);
    expect(JSON.stringify(ctl.views.map((v) => v.values))).toBe(before);
  });
});

describe('Controller — modo compatível (mock do <input webkitdirectory> e das descargas)', () => {
  it('converte caminhos do browser para caminhos da pasta', () => {
    expect(toAppRelPath('RegistoGravidas/data/events/2026/10/a.json')).toBe('data/events/2026/10/a.json');
    expect(toAppRelPath('OneDrive/RegistoGravidas/data/config.json')).toBe('data/config.json');
    expect(toAppRelPath('data/snapshots/s.json')).toBe('data/snapshots/s.json');
    expect(toAppRelPath('events/2026/10/a.json')).toBe('data/events/2026/10/a.json');
    expect(toAppRelPath('RegistoGravidas/index.html')).toBeNull();
    expect(entriesFromPicked([]).looksLikeAppFolder).toBe(false);
  });

  it('ciclo completo: ler, gravar por descarga, fila pendente, confirmar após mover o ficheiro', async () => {
    const folder = memRoot();
    folder.putFile('index.html', '<html>');
    folder.putFile('data/config.json', JSON.stringify({ UnidadeFuncional: ['Unidade Teste'], ProvenienciaContacto: ['Plataforma'] }));
    const ext = sampleEvent();
    folder.putFile(eventRelPath(ext), serializeEvent(ext));
    const { ctl, downloads } = makeCtl({ author: 'Rui', directoryPicker: false });
    await ctl.useCompatFiles(folder.asPickedFiles());
    expect(ctl.mode).toBe('compat');
    expect(ctl.canAutoRefresh).toBe(false);
    expect(ctl.config.UnidadeFuncional).toEqual(['Unidade Teste']);
    expect(ctl.views.map((v) => v.values.Nome)).toEqual(['Fictícia Externa']);

    const ev = ctl.newEvent('update', ext.recordId, { Telefone: { from: '', to: '912345678' } }, ctl.record(ext.recordId)!.rev);
    const r = await ctl.commit(ev);
    expect(r).toMatchObject({ ok: true, how: 'download', path: eventRelPath(ev), persisted: true });
    expect(downloads[0].name).toBe(eventRelPath(ev).split('/').pop());
    expect(await downloads[0].data.text()).toBe(serializeEvent(ev));
    expect(ctl.record(ext.recordId)!.values.Telefone).toBe('912345678');
    expect(ctl.pendingIds.has(ev.id)).toBe(true);

    // "Atualizar" sem o ficheiro movido: continua pendente
    await ctl.useCompatFiles(folder.asPickedFiles());
    expect(ctl.pending.list()).toHaveLength(1);

    // o utilizador move o ficheiro para data/events (qualquer subpasta serve)
    folder.putFile(`data/events/${downloads[0].name}`, await downloads[0].data.text());
    await ctl.useCompatFiles(folder.asPickedFiles());
    expect(ctl.pending.list()).toHaveLength(0);
    expect(ctl.lastConfirmed.map((i) => i.id)).toEqual([ev.id]);
    expect(ctl.record(ext.recordId)!.values.Telefone).toBe('912345678');
  });

  it('pendentes sobrevivem ao fecho do browser (fila em localStorage)', async () => {
    const kv = new TestKV();
    const a = makeCtl({ author: 'Rui', directoryPicker: false, kv });
    await a.ctl.useCompatFiles([]);
    const ev = a.ctl.newEvent('create', 'rx', { Nome: { from: null, to: 'Teste' }, DUM: { from: null, to: '2026-05-01' } }, null);
    await a.ctl.commit(ev);
    const b = makeCtl({ author: 'Rui', directoryPicker: false, kv });
    b.ctl.rebuild();
    expect(b.ctl.record('rx')?.values.Nome).toBe('Teste');
    b.ctl.redownloadPending();
    expect(b.downloads).toHaveLength(1);
  });

  it('vários eventos (importação) → um único ZIP com a estrutura AAAA/MM', async () => {
    const { ctl, downloads } = makeCtl({ author: 'Rui', directoryPicker: false });
    await ctl.useCompatFiles([]);
    const evs = [1, 2, 3].map((i) => ctl.newEvent('create', `z${i}`, { Nome: { from: null, to: `Z${i}` } }, null));
    const r = await ctl.commitMany(evs);
    expect(r).toMatchObject({ written: 3, how: 'download', persisted: true });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/\.zip$/);
    const bytes = new Uint8Array(await downloads[0].data.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    for (const e of evs) expect(text).toContain(eventRelPath(e).replace('data/events/', ''));
  });

  it('os dois modos coexistem na mesma pasta', async () => {
    const root = memRoot();
    root.putFile('index.html', '<html>');
    const full = makeCtl({ root, author: 'Completo' });
    await full.ctl.pickFolderFull();
    await full.ctl.commit(full.ctl.newEvent('create', 'm1', { Nome: { from: null, to: 'Mista' }, DUM: { from: null, to: '2026-04-01' } }, null));

    const compat = makeCtl({ author: 'Compatível', directoryPicker: false });
    await compat.ctl.useCompatFiles(root.asPickedFiles());
    const rec = compat.ctl.record('m1')!;
    await compat.ctl.commit(compat.ctl.newEvent('update', 'm1', { Contactada: { from: '', to: 'Sim' } }, rec.rev));
    const dl = compat.downloads[0];
    const [y, m] = [dl.name.slice(0, 4), dl.name.slice(5, 7)];
    root.putFile(`data/events/${y}/${m}/${dl.name}`, await dl.data.text());

    await full.ctl.refresh();
    expect(full.ctl.record('m1')!.values.Contactada).toBe('Sim');
    expect(full.ctl.record('m1')!.state.history.map((x) => x.author)).toContain('Compatível');
    await compat.ctl.useCompatFiles(root.asPickedFiles());
    expect(compat.ctl.pending.list()).toHaveLength(0);
  });
});

describe('recuperação de gravações interrompidas', () => {
  it('ficheiro próprio vazio/truncado é completado; nunca se toca num ficheiro com outro conteúdo', async () => {
    const root = memRoot();
    const b = new FsaBackend(root);
    const ev = sampleEvent();
    const p = eventRelPath(ev);
    root.putFile(p, serializeEvent(ev).slice(0, 25));
    await b.writeEvent(ev);
    expect(root.readText(p)).toBe(serializeEvent(ev));
    root.putFile(p, '{"outro":1}');
    await expect(b.writeEvent(ev)).rejects.toThrow(/diferente/);
    expect(root.readText(p)).toBe('{"outro":1}');
  });
});

describe('"novo/alterado desde a minha última visita"', () => {
  it('marca alterações de outros PCs posteriores à visita anterior; a marca só guarda um hlc', async () => {
    const root = memRoot();
    root.putFile('index.html', '<html>');
    let t = Date.UTC(2026, 9, 3, 9);
    const now = () => new Date(t);
    const kvB = new TestKV();
    const A = makeCtl({ root, author: 'Ana', now }).ctl;
    await A.pickFolderFull();
    await A.commit(A.newEvent('create', 'velho', { Nome: { from: null, to: 'Antiga' } }, null));

    const B1 = makeCtl({ root, author: 'Bruno', now, kv: kvB }).ctl;
    await B1.pickFolderFull();
    expect(B1.changeMark(B1.record('velho')!)).toBeNull(); // primeira visita: sem marcas
    const marker = kvB.get('lastVisit');
    expect(marker).toMatch(/^\d{15}-\d{6}$/);
    B1.stopTimer();

    t += 3_600_000;
    await A.commit(A.newEvent('create', 'novo', { Nome: { from: null, to: 'Nova' } }, null));
    await A.commit(A.newEvent('update', 'velho', { Telefone: { from: '', to: '912345678' } }, A.record('velho')!.rev));

    const B2 = makeCtl({ root, author: 'Bruno', now, kv: kvB }).ctl; // nova sessão no PC do Bruno
    expect(B2.deviceId).toBe(B1.deviceId);
    await B2.pickFolderFull();
    expect(B2.changeMark(B2.record('novo')!)).toBe('novo');
    expect(B2.changeMark(B2.record('velho')!)).toBe('alterado');
    // alterações do próprio PC não são marcadas
    await B2.commit(B2.newEvent('update', 'velho', { Email: { from: '', to: 'b@example.com' } }, B2.record('velho')!.rev));
    B2.markAllSeen();
    expect(B2.changeMark(B2.record('novo')!)).toBeNull();
    expect([...kvB.m.values()].join(' ')).not.toMatch(/Nova|Antiga|912345678/);
  });
});
