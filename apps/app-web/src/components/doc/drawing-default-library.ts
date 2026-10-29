import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { defaultDrawingLibrary as sharedDefaultLibrary } from '@use-brian/shared/drawing';

export function defaultDrawingLibrary(version: 1 | 2 | 3 | 4 = 4): LibraryItems {
  return sharedDefaultLibrary(version) as unknown as LibraryItems;
}
