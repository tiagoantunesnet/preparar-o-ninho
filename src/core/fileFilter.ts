/**
 * Decide se um ficheiro encontrado na pasta deve ser lido.
 * Devolve null se for para ler, ou o motivo pelo qual é ignorado.
 */
export function ignoreReason(name: string, size?: number): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.crswap')) return 'ficheiro temporário do browser (.crswap)';
  if (lower.endsWith('.tmp') || lower.endsWith('.temp')) return 'ficheiro temporário (.tmp)';
  if (lower.endsWith('.partial') || lower.endsWith('.crdownload') || lower.endsWith('.download')) return 'descarga incompleta';
  if (lower.startsWith('~$') || lower.startsWith('~')) return 'ficheiro temporário (~)';
  if (lower.startsWith('.')) return 'ficheiro oculto/temporário do OneDrive';
  if (lower === 'desktop.ini' || lower === 'thumbs.db') return 'ficheiro de sistema';
  if (!lower.endsWith('.json')) return 'não é um ficheiro .json';
  if (size === 0) return 'ficheiro vazio (talvez ainda a sincronizar)';
  return null;
}
