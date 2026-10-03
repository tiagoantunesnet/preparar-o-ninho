/**
 * Mock em memória da File System Access API (subconjunto usado pela app).
 * Simula também o comportamento do Chrome de escrever primeiro para
 * "<nome>.crswap" e só renomear no close().
 */
import type { DirHandleLike, FileHandleLike, FileLike, PermState, WritableLike } from '../../src/storage/fsTypes';

export interface MemFsOptions {
  /** Falha todas as escritas (simula pasta só de leitura / política). */
  readOnly: boolean;
  /** Falha a próxima escrita apenas. */
  failNextWrite: boolean;
  permission: PermState;
  getFileCalls: number;
  now: () => number;
}

class MemFileData implements FileLike {
  constructor(
    private readonly data: Uint8Array,
    readonly lastModified: number,
  ) {}
  get size() {
    return this.data.length;
  }
  async text() {
    return new TextDecoder().decode(this.data);
  }
  async arrayBuffer() {
    return this.data.slice().buffer as ArrayBuffer;
  }
}

const enc = new TextEncoder();

export class MemFileHandle implements FileHandleLike {
  readonly kind = 'file' as const;
  data: Uint8Array = new Uint8Array();
  lastModified: number;
  constructor(
    readonly name: string,
    private parent: MemDir,
    private opts: MemFsOptions,
  ) {
    this.lastModified = opts.now();
  }
  async getFile(): Promise<FileLike> {
    this.opts.getFileCalls++;
    if (!this.parent.children.has(this.name)) throw new DOMException('removido', 'NotFoundError');
    return new MemFileData(this.data, this.lastModified);
  }
  async createWritable(): Promise<WritableLike> {
    if (this.opts.readOnly) throw new DOMException('A escrita não é permitida', 'NotAllowedError');
    const swapName = `${this.name}.crswap`;
    const swap = new MemFileHandle(swapName, this.parent, this.opts);
    this.parent.children.set(swapName, swap);
    const chunks: Uint8Array[] = [];
    return {
      write: async (d) => {
        if (this.opts.failNextWrite) {
          this.opts.failNextWrite = false;
          throw new DOMException('Disco cheio (simulado)', 'QuotaExceededError');
        }
        if (typeof d === 'string') chunks.push(enc.encode(d));
        else if (d instanceof Uint8Array) chunks.push(d);
        else if (d instanceof ArrayBuffer) chunks.push(new Uint8Array(d));
        else chunks.push(new Uint8Array(await (d as Blob).arrayBuffer()));
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) {
          out.set(c, p);
          p += c.length;
        }
        this.data = out;
        this.lastModified = this.opts.now();
        this.parent.children.delete(swapName);
      },
      abort: async () => {
        this.parent.children.delete(swapName);
      },
    };
  }
}

export class MemDir implements DirHandleLike {
  readonly kind = 'directory' as const;
  children = new Map<string, MemDir | MemFileHandle>();
  constructor(
    readonly name: string,
    readonly opts: MemFsOptions,
  ) {}

  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandleLike> {
    const c = this.children.get(name);
    if (c instanceof MemDir) return c;
    if (c) throw new DOMException('não é uma pasta', 'TypeMismatchError');
    if (!o?.create) throw new DOMException(`${name} não existe`, 'NotFoundError');
    if (this.opts.readOnly) throw new DOMException('A escrita não é permitida', 'NotAllowedError');
    const d = new MemDir(name, this.opts);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike> {
    const c = this.children.get(name);
    if (c instanceof MemFileHandle) return c;
    if (c) throw new DOMException('não é um ficheiro', 'TypeMismatchError');
    if (!o?.create) throw new DOMException(`${name} não existe`, 'NotFoundError');
    if (this.opts.readOnly) throw new DOMException('A escrita não é permitida', 'NotAllowedError');
    const f = new MemFileHandle(name, this, this.opts);
    this.children.set(name, f);
    return f;
  }
  async removeEntry(name: string): Promise<void> {
    if (this.opts.readOnly) throw new DOMException('A escrita não é permitida', 'NotAllowedError');
    if (!this.children.delete(name)) throw new DOMException(`${name} não existe`, 'NotFoundError');
  }
  async *entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]> {
    for (const [k, v] of [...this.children]) yield [k, v];
  }
  async queryPermission(): Promise<PermState> {
    return this.opts.permission;
  }
  async requestPermission(): Promise<PermState> {
    if (this.opts.permission === 'prompt') this.opts.permission = 'granted';
    return this.opts.permission;
  }

  // --- utilidades de teste (escrevem "por fora" da app, como o OneDrive faria)
  putFile(path: string, content: string | Uint8Array): MemFileHandle {
    const segs = path.split('/');
    const name = segs.pop()!;
    let d: MemDir = this;
    for (const s of segs) {
      let n = d.children.get(s);
      if (!(n instanceof MemDir)) {
        n = new MemDir(s, this.opts);
        d.children.set(s, n);
      }
      d = n;
    }
    const f = new MemFileHandle(name, d, this.opts);
    f.data = typeof content === 'string' ? enc.encode(content) : content;
    d.children.set(name, f);
    return f;
  }
  readText(path: string): string | null {
    const segs = path.split('/');
    let n: MemDir | MemFileHandle | undefined = this;
    for (const s of segs) {
      if (!(n instanceof MemDir)) return null;
      n = n.children.get(s);
    }
    return n instanceof MemFileHandle ? new TextDecoder().decode(n.data) : null;
  }
  listFiles(prefix = ''): string[] {
    const out: string[] = [];
    for (const [k, v] of this.children) {
      if (v instanceof MemDir) out.push(...v.listFiles(`${prefix}${k}/`));
      else out.push(`${prefix}${k}`);
    }
    return out.sort();
  }
  /** Ficheiros no formato de um <input webkitdirectory> (para o modo compatível). */
  asPickedFiles(rootName = 'RegistoGravidas'): { name: string; webkitRelativePath: string; size: number; lastModified: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }[] {
    return this.listFiles().map((p) => {
      const t = this.readText(p)!;
      const bytes = enc.encode(t);
      return {
        name: p.split('/').pop()!,
        webkitRelativePath: `${rootName}/${p}`,
        size: bytes.length,
        lastModified: 0,
        text: async () => t,
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      };
    });
  }
}

export function memRoot(name = 'RegistoGravidas', o: Partial<MemFsOptions> = {}): MemDir {
  let t = 1_700_000_000_000;
  const opts: MemFsOptions = { readOnly: false, failNextWrite: false, permission: 'granted', getFileCalls: 0, now: () => t++, ...o };
  return new MemDir(name, opts);
}
