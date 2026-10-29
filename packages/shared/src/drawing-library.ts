import { drawingSceneSchema, type DrawingScene } from './drawing.js';

export const LIBRARY_BYTES = 2 * 1024 * 1024;
export type DrawingLibraryItem = { id: string; name?: string; status: 'published' | 'unpublished'; created: number; elements: DrawingScene['elements'] };
export function validateLibraryItems(value: unknown): DrawingLibraryItem[] {
  if (!Array.isArray(value) || value.length > 500 || new TextEncoder().encode(JSON.stringify(value)).length > LIBRARY_BYTES) throw new Error('library-size');
  let count = 0;
  const items = value.map((item: Record<string, unknown>) => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
      !['published', 'unpublished'].includes(String(item.status)) || typeof item.created !== 'number' || !Number.isFinite(item.created) ||
      (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 200)) ||
      !Array.isArray(item.elements) || !item.elements.length) throw new Error('library-data');
    count += item.elements.length;
    if (count > 5000) throw new Error('library-size');
    if (item.elements.some(element => element?.type === 'image' || element?.isDeleted === true)) throw new Error('library-assets');
    const scene = drawingSceneSchema.parse({ version: 1, elements: item.elements, appState: { viewBackgroundColor: '#fff' }, files: {} });
    return { id: item.id, status: item.status, created: item.created, elements: scene.elements,
      ...(item.name !== undefined ? { name: item.name } : {}) };
  });
  return items as unknown as DrawingLibraryItem[];
}
function libraryItemContent(item: DrawingLibraryItem) {
  return JSON.stringify({ elements: item.elements, name: item.name }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
export function parseLibrary(text: string): DrawingLibraryItem[] {
  if (new TextEncoder().encode(text).length > LIBRARY_BYTES) throw new Error('library-size');
  const data = JSON.parse(text);
  if (data?.type !== 'excalidrawlib' || ![1, 2].includes(data.version)) throw new Error('library-data');
  const source = data.version === 1 ? data.library : data.libraryItems;
  if (!Array.isArray(source)) throw new Error('library-data');
  if (!source.length) throw new Error('library-empty');
  const items = source.map(value => {
    const item = data.version === 1 ? { elements: value } : value;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('library-data');
    // Excalidraw's legacy pencil strokes restore as lines, not modern freedraw.
    // Normalize only the type; geometry and unsafe fields still pass validation.
    const elements = Array.isArray(item.elements) ? item.elements.map((element: unknown) =>
      element && typeof element === 'object' && 'type' in element && element.type === 'draw' ?
        { ...element, type: 'line' } : element) : item.elements;
    return { ...item, elements, id: item.id ?? `brian-library-v1-${'0'.repeat(32)}`, status: item.status ?? 'published', created: item.created ?? Date.now() };
  });
  return validateLibraryItems(items).map((item, index) => {
    if (data.version !== 1 && source[index].id != null) return item;
    // FNV-1a 128 is a portable content identity, never a security nonce.
    // Hash before SDK restoration generates volatile legacy element defaults.
    let hash = BigInt('0x6c62272e07bb014262b821756295c58d');
    const prime = BigInt('0x1000000000000000000013b');
    for (const byte of new TextEncoder().encode(libraryItemContent(item))) {
      hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * prime);
    }
    return { ...item, id: `brian-library-v1-${hash.toString(16).padStart(32, '0')}` };
  });
}
