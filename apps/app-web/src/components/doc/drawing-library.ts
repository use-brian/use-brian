import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { defaultDrawingLibrary } from './drawing-default-library';
import { validateLibraryItems as validateSharedItems, parseLibrary as parseSharedLibrary, drawingLibraryIndexSchema, drawingLibraryPreviewPathSchema } from '@use-brian/shared/drawing';

export function validateLibraryItems(value: unknown): LibraryItems { return validateSharedItems(value) as unknown as LibraryItems; }
export function parseLibrary(text: string): LibraryItems { return parseSharedLibrary(text) as unknown as LibraryItems; }

export const LIBRARY_BYTES = 2 * 1024 * 1024;
export function isLocalLibraryOrigin(href: string) {
  const { protocol, hostname } = new URL(href);
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return protocol === 'http:' || host === 'localhost' || !host.includes('.') && !host.includes(':') ||
    /\.(localhost|local|internal|lan|home)$/.test(host) ||
    /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^\[::ffff:/.test(host) || /^\[(::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)\]$/.test(host);
}
export type LibraryTarget = { key: string; account: string; path: string; block: string };
export function libraryKey(api: string, account: string, workspace: string) {
  return `brian:drawing-library:v1:${JSON.stringify([api, account, workspace])}`;
}
export function officialLibraryUrl(raw: string) {
  if (raw.length > 2048) throw new Error('library-url');
  const url = new URL(raw);
  if (url.origin !== 'https://libraries.excalidraw.com' || url.username || url.password ||
    !/^\/libraries\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.excalidrawlib$/.test(url.pathname) || url.hash || url.search) {
    throw new Error('library-url');
  }
  return url.href;
}
function libraryItemContent(item: LibraryItems[number]) {
  return JSON.stringify({ elements: item.elements, name: item.name }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
function isRetiredDefault(item: LibraryItems[number]) {
  if (item.id !== 'brian-default-v1-use-brian') return false;
  // V1 and V2 share the tiled logo; V3 used a single silhouette.
  return ([1, 3] as const).some(version => {
    const old = defaultDrawingLibrary(version)[0];
    return item.status === old.status && item.created === old.created &&
      libraryItemContent(item) === libraryItemContent(old);
  });
}
export function mergeLibraries(existing: LibraryItems, incoming: LibraryItems): LibraryItems {
  const merged = [...existing];
  const signature = libraryItemContent;
  const ids = new Set(existing.map(item => item.id));
  const signatures = new Set(existing.map(signature));
  for (const item of incoming) {
    if (!ids.has(item.id) && !signatures.has(signature(item))) {
      merged.push(item); ids.add(item.id); signatures.add(signature(item));
    }
  }
  return validateLibraryItems(merged);
}
export function readLibrary(key: string): LibraryItems {
  return readLibraryState(key).items;
}
function readLibraryState(key: string): { items: LibraryItems; defaultsSeeded: boolean; defaultsVersion?: 1 | 2 | 3 | 4 } {
  const text = localStorage.getItem(key);
  if (!text) return { items: [], defaultsSeeded: false };
  if (text.length > LIBRARY_BYTES + 64) throw new Error('library-size');
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { items: validateLibraryItems(data), defaultsSeeded: false };
  if (!data || data.defaultsSeeded !== true) throw new Error('library-data');
  return { items: validateLibraryItems(data.items), defaultsSeeded: true, defaultsVersion: data.defaultsVersion === 4 ? 4 : data.defaultsVersion === 3 ? 3 : data.defaultsVersion === 2 ? 2 : 1 };
}
export function initializeLibrary(key: string): LibraryItems {
  const stored = readLibraryState(key);
  if (stored.defaultsSeeded) {
    if (stored.defaultsVersion === 4) return stored.items;
    const oldDefaults = new Map(defaultDrawingLibrary(stored.defaultsVersion ?? 1).map(item => [item.id, item]));
    const defaults = new Map(defaultDrawingLibrary().map(item => [item.id, item]));
    const items = validateLibraryItems(stored.items.filter(item => !isRetiredDefault(item)).map(item => {
      const old = oldDefaults.get(item.id);
      // An ID or source tag alone is not ownership: preserve every user edit.
      return old && item.status === old.status && item.created === old.created &&
        libraryItemContent(item) === libraryItemContent(old) ? defaults.get(item.id)! : item;
    }));
    localStorage.setItem(key, JSON.stringify({ items, defaultsSeeded: true, defaultsVersion: 4 }));
    return items;
  }
  let items: LibraryItems;
  try { items = mergeLibraries(stored.items, defaultDrawingLibrary()); }
  catch (cause) {
    // Defaults are optional: keep a full saved library usable and retry on reopen.
    if (cause instanceof Error && cause.message === 'library-size') return stored.items;
    throw cause;
  }
  localStorage.setItem(key, JSON.stringify({ items, defaultsSeeded: true, defaultsVersion: 4 }));
  return items;
}
export function persistLibrary(key: string, previous: LibraryItems, next: LibraryItems) {
  const validated = validateLibraryItems(next);
  const removed = new Set(previous.filter(item => !validated.some(next => next.id === item.id)).map(item => item.id));
  const stored = readLibraryState(key);
  // Ignore stale notifications from before retirement, not explicit new imports.
  const incoming = stored.defaultsVersion === 4 && previous.some(isRetiredDefault)
    ? validated.filter(item => !isRetiredDefault(item)) : validated;
  const merged = mergeLibraries(stored.items.filter(item => !removed.has(item.id)), incoming);
  localStorage.setItem(key, JSON.stringify(stored.defaultsSeeded ?
    { items: merged, defaultsSeeded: true, defaultsVersion: stored.defaultsVersion } : merged));
  return merged;
}
export async function fetchLibrary(raw: string, signal: AbortSignal) {
  return parseLibrary(await fetchLibraryText(officialLibraryUrl(raw), signal));
}
export async function fetchLibraryIndex(signal: AbortSignal) {
  const entries = drawingLibraryIndexSchema.parse(JSON.parse(await fetchLibraryText('https://libraries.excalidraw.com/libraries.json', signal)));
  return [...new Map(entries.map(entry => {
    const url = officialLibraryUrl(`https://libraries.excalidraw.com/libraries/${entry.source}`);
    return [url, { name: entry.name, authors: entry.authors.map(author => author.name).join(', '), url,
      preview: entry.preview ? officialLibraryPreviewUrl(entry.preview) : undefined }];
  })).values()];
}
export function officialLibraryPreviewUrl(path: string) {
  return new URL(drawingLibraryPreviewPathSchema.parse(path), 'https://libraries.excalidraw.com/libraries/').href;
}
async function fetchLibraryText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > LIBRARY_BYTES) throw new Error('library-fetch');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIBRARY_BYTES) throw new Error('library-size');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
