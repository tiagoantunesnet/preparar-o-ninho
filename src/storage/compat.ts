/**
 * Modo compatível: leitura via <input type="file" webkitdirectory> e gravação
 * por descarga de ficheiros, que o utilizador move para data\events.
 */
import type { FileLike } from './fsTypes';
import type { FileEntry } from './reader';

export interface PickedFile extends FileLike {
  readonly name: string;
  readonly webkitRelativePath: string;
}

const DATA_CHILDREN = new Set(['events', 'snapshots', 'config.json', 'archive']);

/**
 * Converte o caminho relativo devolvido pelo browser ("RegistoGravidas/data/events/…")
 * no caminho relativo à pasta da app ("data/events/…"). Tolera que o utilizador
 * tenha escolhido a pasta-mãe, a própria pasta data ou a pasta events.
 */
export function toAppRelPath(webkitRelativePath: string): string | null {
  const segs = webkitRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].toLowerCase() === 'data' && DATA_CHILDREN.has(segs[i + 1].toLowerCase())) {
      return ['data', ...segs.slice(i + 1)].join('/');
    }
  }
  if (segs.length >= 2 && segs[0].toLowerCase() === 'events') return ['data', ...segs].join('/');
  return null;
}

export interface PickSummary {
  entries: FileEntry[];
  rootName: string;
  totalFiles: number;
  looksLikeAppFolder: boolean;
}

export function entriesFromPicked(files: ArrayLike<PickedFile>): PickSummary {
  const entries: FileEntry[] = [];
  let rootName = '';
  let hasIndex = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const p = f.webkitRelativePath || f.name;
    if (!rootName) rootName = p.split('/')[0] ?? '';
    if (/(^|\/)index\.html$/i.test(p)) hasIndex = true;
    const rel = toAppRelPath(p);
    if (!rel) continue;
    entries.push({ relPath: rel, name: f.name, getFile: async () => f });
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { entries, rootName, totalFiles: files.length, looksLikeAppFolder: hasIndex || entries.length > 0 };
}

export type Downloader = (fileName: string, data: Blob) => void;

/** Descarga via <a download>. */
export const browserDownloader: Downloader = (fileName, data) => {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
