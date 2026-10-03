/**
 * Utilitários E2E. Cada teste trabalha numa cópia nova de RegistoGravidas/
 * numa pasta temporária, aberta via file://.
 *
 * Modo completo: o Chromium em modo automático não permite interagir com o
 * seletor de pastas nativo, por isso injeta-se um `showDirectoryPicker` que
 * devolve um handle cujas operações são executadas pelo Node na pasta real
 * (page.exposeFunction). Assim os dois modos operam sobre a MESMA pasta em disco.
 *
 * Modo compatível: remove-se `showDirectoryPicker` e usa-se o
 * <input webkitdirectory> real (setFiles com a pasta) e as descargas reais.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(PROJECT, 'RegistoGravidas');
export const FIXTURE_XLSX = join(PROJECT, 'tests', 'fixtures', 'registo_gravidas_ANONIMIZADO.xlsx');
export const FIXED_NOW = new Date('2026-10-03T10:00:00+01:00');

export function makeFolder(): string {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('Execute "npm run build" antes dos testes E2E');
  const base = mkdtempSync(join(tmpdir(), 'rg-e2e-'));
  const folder = join(base, 'RegistoGravidas');
  cpSync(DIST, folder, { recursive: true });
  return folder;
}

export function cleanup(folder: string): void {
  rmSync(dirname(folder), { recursive: true, force: true });
}

export function listFiles(folder: string, sub = ''): string[] {
  const dir = join(folder, sub);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(folder, rel));
    else out.push(rel);
  }
  return out.sort();
}

function inside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('caminho fora da pasta: ' + p);
  return abs;
}

/** Ponte Node <-> handle simulado (modo completo). */
export async function exposeFolder(context: BrowserContext, folder: string): Promise<void> {
  await context.exposeFunction('rgfs', (op: string, p: string, data?: string) => {
    const abs = inside(folder, p || '.');
    switch (op) {
      case 'stat':
        if (!existsSync(abs)) return null;
        return statSync(abs).isDirectory() ? 'dir' : 'file';
      case 'list':
        return readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
      case 'read': {
        if (!existsSync(abs)) return null;
        const b = readFileSync(abs);
        return { b64: b.toString('base64'), mtime: statSync(abs).mtimeMs };
      }
      case 'mkdir':
        mkdirSync(abs, { recursive: true });
        return true;
      case 'write':
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, data ?? '');
        return true;
      case 'remove':
        rmSync(abs);
        return true;
      default:
        throw new Error('op desconhecida ' + op);
    }
  });
}

const FULL_MODE_SCRIPT = `(() => {
  const call = (op, p, d) => window.rgfs(op, p, d);
  const ro = () => !!window.__rgReadOnly;
  const err = (name, msg) => new DOMException(msg || name, name);
  class FH {
    constructor(path, name) { this.kind = 'file'; this.name = name; this.__path = path; }
    async getFile() {
      const r = await call('read', this.__path);
      if (!r) throw err('NotFoundError');
      const bin = atob(r.b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], this.name, { lastModified: Math.floor(r.mtime) });
    }
    async createWritable() {
      if (ro()) throw err('NotAllowedError', 'escrita bloqueada (teste)');
      const parts = []; const p = this.__path;
      return {
        async write(d) { parts.push(typeof d === 'string' ? d : await new Blob([d]).text()); },
        async close() { await call('write', p, parts.join('')); },
        async abort() {},
      };
    }
  }
  class DH {
    constructor(path, name) { this.kind = 'directory'; this.name = name; this.__path = path; }
    _p(n) { return this.__path ? this.__path + '/' + n : n; }
    async getDirectoryHandle(n, o) {
      const t = await call('stat', this._p(n));
      if (t === 'dir') return new DH(this._p(n), n);
      if (t) throw err('TypeMismatchError');
      if (!o || !o.create) throw err('NotFoundError');
      if (ro()) throw err('NotAllowedError', 'escrita bloqueada (teste)');
      await call('mkdir', this._p(n)); return new DH(this._p(n), n);
    }
    async getFileHandle(n, o) {
      const t = await call('stat', this._p(n));
      if (t === 'file') return new FH(this._p(n), n);
      if (t) throw err('TypeMismatchError');
      if (!o || !o.create) throw err('NotFoundError');
      if (ro()) throw err('NotAllowedError', 'escrita bloqueada (teste)');
      await call('write', this._p(n), ''); return new FH(this._p(n), n);
    }
    async removeEntry(n) { if (ro()) throw err('NotAllowedError'); await call('remove', this._p(n)); }
    async *entries() {
      const list = await call('list', this.__path);
      for (const e of list) yield [e.name, e.kind === 'dir' ? new DH(this._p(e.name), e.name) : new FH(this._p(e.name), e.name)];
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  window.showDirectoryPicker = async () => new DH('', 'RegistoGravidas');
})();`;

const COMPAT_MODE_SCRIPT = `(() => {
  try { delete Window.prototype.showDirectoryPicker; } catch (e) {}
  try { delete window.showDirectoryPicker; } catch (e) {}
  Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
})();`;

export type Mode = 'full' | 'compat' | 'full-readonly';
const exposed = new WeakSet<BrowserContext>();

export async function openApp(context: BrowserContext, folder: string, mode: Mode, now: Date = FIXED_NOW): Promise<Page> {
  if (mode === 'compat') await context.addInitScript(COMPAT_MODE_SCRIPT);
  else if (!exposed.has(context)) {
    exposed.add(context);
    await exposeFolder(context, folder);
    await context.addInitScript(FULL_MODE_SCRIPT);
    if (mode === 'full-readonly') await context.addInitScript('window.__rgReadOnly = true;');
  }
  const page = await context.newPage();
  await page.clock.install({ time: now });
  await page.clock.resume();
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto(pathToFileURL(join(folder, 'index.html')).href);
  return page;
}

export async function firstUse(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Primeira utilização' })).toBeVisible();
  await page.getByLabel('O seu nome').fill(name);
  await page.getByRole('button', { name: 'Continuar' }).click();
}

export async function pickCompatFolder(page: Page, folder: string, trigger: () => Promise<void>): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await trigger();
  await (await chooser).setFiles(folder);
}

/** Guarda uma descarga onde o utilizador a deveria mover. */
export async function saveDownloadTo(folder: string, download: { suggestedFilename(): string; saveAs(p: string): Promise<void> }, sub: string): Promise<string> {
  const target = join(folder, sub, download.suggestedFilename());
  mkdirSync(dirname(target), { recursive: true });
  await download.saveAs(target);
  return relative(folder, target).split(sep).join('/');
}

export function readJson(folder: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(folder, rel), 'utf8'));
}

export function writeRaw(folder: string, rel: string, text: string): void {
  const abs = join(folder, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}
