import './ui/styles.css';
import { Controller, idbHandleStore } from './app/controller';
import { detectCapabilities } from './storage/capabilities';
import { browserDownloader } from './storage/compat';
import type { DirHandleLike } from './storage/fsTypes';
import { idbDelete, idbGet, idbSet } from './storage/idb';
import { createKV } from './storage/kv';
import { UI } from './ui/app';

type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandleLike> };

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  try {
    const caps = await detectCapabilities();
    const kv = createKV();
    const w = window as PickerWindow;
    const ctl = new Controller({
      kv,
      caps,
      handleStore: caps.indexedDB ? idbHandleStore(idbGet, idbSet, idbDelete) : null,
      downloader: browserDownloader,
      pickDirectory: caps.directoryPicker ? () => w.showDirectoryPicker!({ id: 'registo-gravidas', mode: 'readwrite' }) : null,
    });
    const ui = new UI(ctl, root);
    ui.start();
    await ctl.init();
    (window as unknown as { __rg?: unknown }).__rg = { ctl, ui };
  } catch (e) {
    root.textContent = '';
    const p = document.createElement('p');
    p.className = 'banner banner-error';
    p.setAttribute('role', 'alert');
    p.textContent = 'Erro ao iniciar a aplicação: ' + (e instanceof Error ? e.message : String(e)) + '. Use o Microsoft Edge ou o Google Chrome atualizados.';
    root.appendChild(p);
  }
}

void boot();
