/**
 * Acesso direto à pasta via File System Access API (modo completo) e
 * listagem de ficheiros a partir de um handle (também usada no modo
 * compatível quando a leitura pelo handle funciona mas a escrita não).
 *
 * Regra de ouro: só se criam ficheiros novos com nomes únicos; nunca se
 * altera nem apaga um ficheiro existente — exceto o ficheiro de teste próprio
 * (data/.probe/<deviceId>) e a opção explícita de arquivar (copia, verifica e
 * só depois remove o original).
 */
import { eventDir, eventFileName, serializeEvent } from '../core/events';
import { serializeSnapshot, snapshotFileName, type SnapshotFile } from '../core/snapshot';
import { DEFAULT_CONFIG, type RgEvent } from '../core/types';
import type { DirHandleLike, FileHandleLike } from './fsTypes';
import { errMsg, type FileEntry } from './reader';

const SKIP_DIRS = new Set(['archive', '.probe']);

/** Lista recursivamente data/ (exceto data/archive e data/.probe). */
export async function listDataFiles(root: DirHandleLike): Promise<FileEntry[]> {
  let data: DirHandleLike;
  try {
    data = await root.getDirectoryHandle('data');
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  async function walk(dir: DirHandleLike, prefix: string, depth: number): Promise<void> {
    if (depth > 6) return;
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') {
        if (depth === 0 && SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') || name.startsWith('~')) continue;
        await walk(h as DirHandleLike, `${prefix}${name}/`, depth + 1);
      } else {
        const fh = h as FileHandleLike;
        out.push({ relPath: `${prefix}${name}`, name, getFile: () => fh.getFile() });
      }
    }
  }
  await walk(data, 'data/', 0);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

async function getDir(root: DirHandleLike, segs: string[], create: boolean): Promise<DirHandleLike> {
  let d = root;
  for (const s of segs) d = await d.getDirectoryHandle(s, { create });
  return d;
}

async function exists(dir: DirHandleLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export class WriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteError';
  }
}

/** Cria um ficheiro NOVO e confirma, relendo-o, que o conteúdo ficou em disco. */
export async function writeNewFile(root: DirHandleLike, segs: string[], name: string, content: string | Uint8Array): Promise<void> {
  let dir: DirHandleLike;
  try {
    dir = await getDir(root, segs, true);
  } catch (e) {
    throw new WriteError(`não foi possível abrir/criar a pasta ${segs.join('/')}: ${errMsg(e)}`);
  }
  const expected = typeof content === 'string' ? content : new TextDecoder().decode(content);
  if (await exists(dir, name)) {
    // Repetição de uma gravação anterior cujo resultado não foi confirmado: se o
    // conteúdo é idêntico, já está gravado; caso contrário nunca se sobrepõe.
    // Um ficheiro vazio ou truncado com este nome só pode ser uma tentativa
    // anterior nossa que falhou (o nome inclui o nosso deviceId e um uuid).
    let cur: string | null = null;
    try {
      cur = await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      /* cai no erro abaixo */
    }
    if (cur === expected) return;
    if (cur === null || !(cur === '' || expected.startsWith(cur))) {
      throw new WriteError(`já existe um ficheiro diferente com o nome ${name}`);
    }
  }
  let fh: FileHandleLike;
  try {
    fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(content);
      await w.close();
    } catch (e) {
      try {
        await w.abort?.();
      } catch {
        /* ignorar */
      }
      throw e;
    }
  } catch (e) {
    // Remove o ficheiro (nosso) que possa ter ficado vazio.
    try {
      const left = await (await (await dir.getFileHandle(name)).getFile()).text();
      if (left === '' || expected.startsWith(left)) await dir.removeEntry(name);
    } catch {
      /* não existe ou não foi possível — a próxima tentativa trata disso */
    }
    throw new WriteError(`falha ao gravar ${segs.join('/')}/${name}: ${errMsg(e)}`);
  }
  try {
    const back = await (await fh.getFile()).text();
    if (back !== expected) throw new Error('o conteúdo relido não confere');
  } catch (e) {
    throw new WriteError(`gravação não confirmada (${name}): ${errMsg(e)}`);
  }
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
}

/** Escreve e apaga data/.probe/<deviceId> para confirmar permissão de escrita efetiva. */
export async function writeProbe(root: DirHandleLike, deviceId: string): Promise<ProbeResult> {
  try {
    const dir = await getDir(root, ['data', '.probe'], true);
    const fh = await dir.getFileHandle(deviceId, { create: true });
    const w = await fh.createWritable();
    const token = `probe ${new Date().toISOString()}`;
    await w.write(token);
    await w.close();
    const back = await (await fh.getFile()).text();
    await dir.removeEntry(deviceId);
    if (back !== token) return { ok: false, error: 'o ficheiro de teste não foi relido corretamente' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** A pasta escolhida parece ser a RegistoGravidas? */
export async function looksLikeAppFolder(root: DirHandleLike): Promise<boolean> {
  try {
    await root.getDirectoryHandle('data');
    return true;
  } catch {
    /* continua */
  }
  try {
    await root.getFileHandle('index.html');
    return true;
  } catch {
    return false;
  }
}

export class FsaBackend {
  readonly mode = 'full' as const;

  constructor(readonly root: DirHandleLike) {}

  listFiles(): Promise<FileEntry[]> {
    return listDataFiles(this.root);
  }

  async ensureStructure(): Promise<void> {
    const data = await getDir(this.root, ['data'], true);
    await data.getDirectoryHandle('events', { create: true });
    await data.getDirectoryHandle('snapshots', { create: true });
    if (!(await exists(data, 'config.json'))) {
      await writeNewFile(this.root, ['data'], 'config.json', JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    }
  }

  async writeEvent(ev: RgEvent): Promise<string> {
    const [y, m] = eventDir(ev);
    const name = eventFileName(ev);
    await writeNewFile(this.root, ['data', 'events', y, m], name, serializeEvent(ev));
    return `data/events/${y}/${m}/${name}`;
  }

  /** Grava o texto já serializado de um evento pendente (fila do modo compatível). */
  async writeEventText(relPath: string, text: string): Promise<void> {
    const segs = relPath.split('/');
    const name = segs.pop()!;
    await writeNewFile(this.root, segs, name, text);
  }

  async writeSnapshot(s: SnapshotFile): Promise<string> {
    const name = snapshotFileName(s);
    await writeNewFile(this.root, ['data', 'snapshots'], name, serializeSnapshot(s));
    return `data/snapshots/${name}`;
  }

  probe(deviceId: string): Promise<ProbeResult> {
    return writeProbe(this.root, deviceId);
  }

  /**
   * Move ficheiros de eventos para data/archive (mesma estrutura de subpastas):
   * copia, relê para confirmar e só então remove o original.
   */
  async archiveEvents(relPaths: string[]): Promise<{ moved: number; failed: { path: string; error: string }[] }> {
    let moved = 0;
    const failed: { path: string; error: string }[] = [];
    for (const rel of relPaths) {
      try {
        if (!rel.startsWith('data/events/')) throw new Error('caminho fora de data/events');
        const segs = rel.split('/');
        const name = segs.pop()!;
        const srcDir = await getDir(this.root, segs, false);
        const text = await (await (await srcDir.getFileHandle(name)).getFile()).text();
        const destSegs = ['data', 'archive', ...segs.slice(1)];
        const destDir = await getDir(this.root, destSegs, true);
        if (await exists(destDir, name)) {
          const already = await (await (await destDir.getFileHandle(name)).getFile()).text();
          if (already !== text) throw new Error('já existe no arquivo com conteúdo diferente');
        } else {
          await writeNewFile(this.root, destSegs, name, text);
        }
        await srcDir.removeEntry(name);
        moved++;
      } catch (e) {
        failed.push({ path: rel, error: errMsg(e) });
      }
    }
    return { moved, failed };
  }
}
