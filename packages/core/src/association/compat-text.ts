/**
 * Website content keeps compatibility characters (full-width CJK punctuation,
 * non-breaking hyphens) as `\u{hex}` escapes, and `\` as `\\`, because HTTP
 * request bodies are NFKC-normalized. Website readers and the staff console
 * restore them; assistant tools do the same so the model reads and writes the
 * real text. Mirrors `restoreCompatText`/`preserveCompatText` in app-web
 * `lib/api/association.ts` (app-web does not depend on core); keep them equal.
 * [COMP:crm/site-content]
 */
export function restoreCompatText<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\\(\\|u\{([0-9a-fA-F]{1,6})\})/g, (_match, kind: string, hex?: string) => kind === '\\' ? '\\' : String.fromCodePoint(Number.parseInt(hex ?? '0', 16))) as T
  if (Array.isArray(value)) return value.map(restoreCompatText) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreCompatText(entry)])) as T
  return value
}

export function preserveCompatText<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\\/g, '\\\\').replace(/[\s\S]/gu, char => char.normalize('NFKC') === char ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`) as T
  if (Array.isArray(value)) return value.map(preserveCompatText) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preserveCompatText(entry)])) as T
  return value
}
