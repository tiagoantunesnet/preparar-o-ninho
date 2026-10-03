/**
 * Subconjunto da File System Access API usado pela app. Definido localmente
 * para que os mocks (testes unitários e E2E) implementem exatamente isto.
 */
export interface WritableLike {
  write(data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FileLike {
  readonly size: number;
  readonly lastModified: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<FileLike>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export type PermState = 'granted' | 'denied' | 'prompt';

export interface DirHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermState>;
}

export function isDirHandle(x: unknown): x is DirHandleLike {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as DirHandleLike).kind === 'directory' &&
    typeof (x as DirHandleLike).getDirectoryHandle === 'function' &&
    typeof (x as DirHandleLike).entries === 'function'
  );
}
