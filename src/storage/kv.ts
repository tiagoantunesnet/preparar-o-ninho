/** Armazenamento local simples (localStorage) com alternativa em memória. */
export interface KV {
  readonly persistent: boolean;
  get(key: string): string | null;
  /** Devolve false se não foi possível guardar de forma persistente. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
}

export class MemoryKV implements KV {
  readonly persistent = false;
  private m = new Map<string, string>();
  get(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
    return false;
  }
  remove(k: string) {
    this.m.delete(k);
  }
}

export class StorageKV implements KV {
  readonly persistent = true;
  constructor(private s: Storage, private prefix = 'rg.') {}
  get(k: string) {
    try {
      return this.s.getItem(this.prefix + k);
    } catch {
      return null;
    }
  }
  set(k: string, v: string) {
    try {
      this.s.setItem(this.prefix + k, v);
      return this.s.getItem(this.prefix + k) === v;
    } catch {
      return false;
    }
  }
  remove(k: string) {
    try {
      this.s.removeItem(this.prefix + k);
    } catch {
      /* ignorar */
    }
  }
}

export function createKV(): KV {
  try {
    const s = globalThis.localStorage;
    if (s) {
      const t = 'rg.__test';
      s.setItem(t, '1');
      s.removeItem(t);
      return new StorageKV(s);
    }
  } catch {
    /* indisponível */
  }
  return new MemoryKV();
}
