function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return b;
}

/** UUID v4. Não depende de crypto.randomUUID (indisponível fora de contextos seguros). */
export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Identificador curto do dispositivo: só [a-z0-9], seguro em nomes de ficheiro e sem "_". */
export function newDeviceId(): string {
  const b = randomBytes(10);
  return 'pc' + Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

export const DEVICE_ID_RE = /^[a-z0-9-]{3,40}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
