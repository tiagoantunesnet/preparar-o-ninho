/**
 * Leitura da pasta — comum aos dois modos. Recebe a lista de ficheiros
 * (de um FileSystemDirectoryHandle ou de um <input webkitdirectory>) e devolve
 * eventos, snapshots, config e o relatório para o ecrã Diagnóstico.
 */
import { parseEventText, type ParseResult } from '../core/events';
import { ignoreReason } from '../core/fileFilter';
import { parseSnapshotText, type SnapshotFile } from '../core/snapshot';
import { DEFAULT_CONFIG, type AppConfig, type RgEvent } from '../core/types';
import type { FileLike } from './fsTypes';

export interface FileEntry {
  /** Caminho relativo à pasta RegistoGravidas, com "/" (p.ex. "data/events/2026/10/x.json"). */
  relPath: string;
  name: string;
  getFile(): Promise<FileLike>;
}

export interface IgnoredFile {
  path: string;
  reason: string;
}

export interface ScanResult {
  at: Date;
  events: RgEvent[];
  /** id do evento -> caminho do ficheiro (o primeiro encontrado). */
  eventPaths: Map<string, string>;
  snapshots: { path: string; snapshot: SnapshotFile }[];
  config: AppConfig;
  configFound: boolean;
  configError: string | null;
  eventFiles: number;
  duplicateFiles: number;
  migratedEvents: number;
  newlyRead: number;
  ignored: IgnoredFile[];
}

type Kind = 'event' | 'snapshot' | 'config' | 'skip';

export function classifyPath(relPath: string): Kind {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'data/config.json') return 'config';
  if (p.startsWith('data/events/')) return 'event';
  if (p.startsWith('data/snapshots/')) return 'snapshot';
  return 'skip';
}

export function parseConfig(text: string): ParseResult<AppConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'config.json com JSON inválido' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'config.json não é um objeto' };
  const o = raw as Record<string, unknown>;
  const list = (k: keyof AppConfig): string[] => {
    const v = o[k];
    if (!Array.isArray(v)) return DEFAULT_CONFIG[k];
    const items = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
    return items.length ? items : DEFAULT_CONFIG[k];
  };
  return { ok: true, migrated: false, value: { UnidadeFuncional: list('UnidadeFuncional'), ProvenienciaContacto: list('ProvenienciaContacto') } };
}

interface CacheEntry {
  kind: Kind;
  event?: RgEvent;
  migrated?: boolean;
  snapshot?: SnapshotFile;
}

export class FolderReader {
  /** Ficheiros já lidos com sucesso, por caminho. Eventos e snapshots são imutáveis. */
  private cache = new Map<string, CacheEntry>();
  private configCache: { lastModified: number; size: number; result: ParseResult<AppConfig> } | null = null;

  clear(): void {
    this.cache.clear();
    this.configCache = null;
  }

  get cachedCount(): number {
    return this.cache.size;
  }

  async ingest(files: FileEntry[]): Promise<ScanResult> {
    const ignored: IgnoredFile[] = [];
    const byId = new Map<string, RgEvent>();
    const eventPaths = new Map<string, string>();
    const snapshots: { path: string; snapshot: SnapshotFile }[] = [];
    let eventFiles = 0;
    let duplicateFiles = 0;
    let migratedEvents = 0;
    let newlyRead = 0;
    let config: AppConfig = DEFAULT_CONFIG;
    let configFound = false;
    let configError: string | null = null;

    for (const f of files) {
      const kind = classifyPath(f.relPath);
      if (kind === 'skip') continue;

      if (kind === 'config') {
        try {
          const file = await f.getFile();
          if (!this.configCache || this.configCache.lastModified !== file.lastModified || this.configCache.size !== file.size) {
            this.configCache = { lastModified: file.lastModified, size: file.size, result: parseConfig(await file.text()) };
          }
          const r = this.configCache.result;
          configFound = true;
          if (r.ok) config = r.value;
          else configError = r.reason;
        } catch (e) {
          configError = 'não foi possível ler config.json: ' + errMsg(e);
        }
        continue;
      }

      const why = ignoreReason(f.name);
      if (why) {
        ignored.push({ path: f.relPath, reason: why });
        continue;
      }

      let entry = this.cache.get(f.relPath);
      if (!entry) {
        try {
          const file = await f.getFile();
          const whySize = ignoreReason(f.name, file.size);
          if (whySize) {
            ignored.push({ path: f.relPath, reason: whySize });
            continue;
          }
          const text = await file.text();
          newlyRead++;
          // O tipo decide-se pelo conteúdo: um snapshot guardado por engano em
          // data/events (ou vice-versa, no modo compatível) é aceite na mesma.
          if (looksLikeSnapshot(text)) {
            const r = parseSnapshotText(text);
            if (!r.ok) {
              ignored.push({ path: f.relPath, reason: r.reason });
              continue;
            }
            entry = { kind: 'snapshot', snapshot: r.value };
          } else {
            const r = parseEventText(text);
            if (!r.ok) {
              ignored.push({ path: f.relPath, reason: r.reason });
              continue;
            }
            entry = { kind: 'event', event: r.value, migrated: r.migrated };
          }
          this.cache.set(f.relPath, entry);
        } catch (e) {
          ignored.push({ path: f.relPath, reason: 'erro de leitura (tenta-se de novo): ' + errMsg(e) });
          continue;
        }
      }

      if (entry.kind === 'event' && entry.event) {
        eventFiles++;
        if (byId.has(entry.event.id)) {
          duplicateFiles++;
          ignored.push({ path: f.relPath, reason: `duplicado do evento ${entry.event.id} (ignorado)` });
          continue;
        }
        byId.set(entry.event.id, entry.event);
        eventPaths.set(entry.event.id, f.relPath);
        if (entry.migrated) migratedEvents++;
      } else if (entry.kind === 'snapshot' && entry.snapshot) {
        snapshots.push({ path: f.relPath, snapshot: entry.snapshot });
      }
    }

    // Ficheiros que desapareceram (p.ex. arquivados) deixam de contar.
    const present = new Set(files.map((f) => f.relPath));
    for (const k of this.cache.keys()) if (!present.has(k)) this.cache.delete(k);

    return {
      at: new Date(),
      events: [...byId.values()],
      eventPaths,
      snapshots,
      config,
      configFound,
      configError,
      eventFiles,
      duplicateFiles,
      migratedEvents,
      newlyRead,
      ignored,
    };
  }
}

function looksLikeSnapshot(text: string): boolean {
  return /^\s*\{[\s\S]{0,200}"kind"\s*:\s*"snapshot"/.test(text);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}
