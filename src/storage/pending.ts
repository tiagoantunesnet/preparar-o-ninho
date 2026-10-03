/**
 * Fila local de ficheiros gravados por descarga (modo compatível) que ainda
 * não foram encontrados na pasta. Persistida em localStorage para não se
 * perderem se o browser fechar. Os eventos pendentes entram no estado
 * mostrado (com indicação), e saem da fila quando aparecem numa leitura.
 */
import type { KV } from './kv';

export interface PendingItem {
  kind: 'event' | 'snapshot';
  id: string;
  /** Caminho de destino relativo à pasta, p.ex. data/events/2026/10/<nome>.json */
  relPath: string;
  fileName: string;
  text: string;
  createdAt: string;
  downloads: number;
}

const KEY = 'pending';

export class PendingQueue {
  constructor(private kv: KV) {}

  list(): PendingItem[] {
    const raw = this.kv.get(KEY);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as PendingItem[]) : [];
    } catch {
      return [];
    }
  }

  private save(items: PendingItem[]): boolean {
    return this.kv.set(KEY, JSON.stringify(items));
  }

  /** Devolve true se ficou guardado de forma persistente. */
  add(item: PendingItem): boolean {
    const items = this.list().filter((i) => i.id !== item.id);
    items.push(item);
    return this.save(items);
  }

  addMany(newItems: PendingItem[]): boolean {
    const ids = new Set(newItems.map((i) => i.id));
    const items = this.list().filter((i) => !ids.has(i.id));
    items.push(...newItems);
    return this.save(items);
  }

  markDownloaded(ids: string[]): void {
    const s = new Set(ids);
    this.save(this.list().map((i) => (s.has(i.id) ? { ...i, downloads: i.downloads + 1 } : i)));
  }

  /** Remove os itens confirmados (encontrados na pasta). Devolve os removidos. */
  confirm(foundIds: Set<string>): PendingItem[] {
    const items = this.list();
    const done = items.filter((i) => foundIds.has(i.id));
    if (done.length) this.save(items.filter((i) => !foundIds.has(i.id)));
    return done;
  }

  remove(id: string): void {
    this.save(this.list().filter((i) => i.id !== id));
  }
}
