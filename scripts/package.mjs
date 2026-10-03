// Monta a pasta RegistoGravidas/ pronta a copiar para o OneDrive.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'RegistoGravidas');
const built = join(root, 'dist', 'index.html');
if (!existsSync(built)) throw new Error('dist/index.html não existe — execute "vite build" primeiro');

const html = readFileSync(built, 'utf8');
// Garantias: autocontido e sem pedidos de rede.
if (/<(script|link)[^>]+(src|href)=["']?(https?:)?\/\//i.test(html)) throw new Error('index.html referencia recursos externos');
if (!html.includes("connect-src 'none'")) throw new Error('CSP em falta no index.html');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data', 'events'), { recursive: true });
mkdirSync(join(out, 'data', 'snapshots'), { recursive: true });
writeFileSync(join(out, 'index.html'), html);
cpSync(join(root, 'static', 'LEIA-ME.html'), join(out, 'LEIA-ME.html'));
cpSync(join(root, 'static', 'config.json'), join(out, 'data', 'config.json'));

// Nunca incluir dados (nem o fixture de teste) na pasta final.
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(out).map((f) => f.slice(out.length + 1).replace(/\\/g, '/'));
const bad = files.filter((f) => /\.xlsx?$/i.test(f) || f.startsWith('data/events/') || f.startsWith('data/snapshots/'));
if (bad.length) throw new Error('ficheiros inesperados na pasta final: ' + bad.join(', '));
console.log(`RegistoGravidas/ pronta (${(html.length / 1024).toFixed(0)} KB):\n  ` + files.join('\n  ') + '\n  data/events/ (vazia)\n  data/snapshots/ (vazia)');
