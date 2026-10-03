import { idbAvailable } from './idb';

export interface Capabilities {
  browser: string;
  userAgent: string;
  protocol: string;
  secureContext: boolean;
  directoryPicker: boolean;
  webkitdirectory: boolean;
  indexedDB: boolean;
  localStorage: boolean;
}

export function describeBrowser(ua: string): string {
  const edge = /Edg\/(\d+)/.exec(ua);
  if (edge) return `Microsoft Edge ${edge[1]}`;
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (chrome) return `Google Chrome / Chromium ${chrome[1]}`;
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (ff) return `Mozilla Firefox ${ff[1]} (não suportado oficialmente)`;
  if (/Safari\//.test(ua)) return 'Safari (não suportado oficialmente)';
  return 'Browser desconhecido';
}

export async function detectCapabilities(): Promise<Capabilities> {
  const ua = navigator.userAgent;
  let ls = false;
  try {
    localStorage.setItem('rg.__cap', '1');
    localStorage.removeItem('rg.__cap');
    ls = true;
  } catch {
    ls = false;
  }
  return {
    browser: describeBrowser(ua),
    userAgent: ua,
    protocol: location.protocol,
    secureContext: !!window.isSecureContext,
    directoryPicker: typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
    webkitdirectory: 'webkitdirectory' in document.createElement('input'),
    indexedDB: await idbAvailable(),
    localStorage: ls,
  };
}
