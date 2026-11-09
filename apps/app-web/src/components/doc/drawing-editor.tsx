"use client";

import { useContext, useEffect, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, LibraryItems } from '@excalidraw/excalidraw/types';
import { Dialog } from '@base-ui/react/dialog';
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { drawingTitleSchema, drawingSceneSchema, parseDrawingSceneStructure, drawingPreviewSchema, drawingSceneDigest, MAX_DRAWING_PREVIEW_DIMENSION, type DrawingScene, type DrawingPreview } from '@use-brian/shared/drawing';
import { useLocale, useT } from '@/lib/i18n/client';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { loadDrawingRuntime } from './drawing-runtime';
import { desktopBridge } from '@/lib/desktop-auth-source';
import { LIBRARY_BYTES, mergeLibraries, parseLibrary, persistLibrary, initializeLibrary, validateLibraryItems, isLocalLibraryOrigin,
  type LibraryTarget } from './drawing-library';
import { DrawingLibraryCatalog } from './drawing-library-catalog';
import '@excalidraw/excalidraw/index.css';
import { drawingNamespace, type DrawingCollaboration } from '@use-brian/doc-model';
import { DrawingPageContext } from './block-drawing';
import { bindDrawingPresence } from './drawing-presence';

export default function DrawingEditor({ scene, title, preview: savedPreview, editable, onSave, onCancel, libraryTarget, live }: {
  scene: DrawingScene;
  title?: string;
  preview?: DrawingPreview;
  editable: boolean;
  onSave: (scene: DrawingScene, preview?: DrawingPreview, title?: string) => boolean;
  onCancel: () => void;
  libraryTarget?: LibraryTarget;
  live?: DrawingCollaboration;
}) {
  const t = useT().docPage.diagramSource;
  const locale = useLocale();
  const { resolved } = useTheme();
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof loadDrawingRuntime>> | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? '');
  const titleBeforeFocus = useRef(draftTitle);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);
  useEffect(() => { if (!editable) setCatalogOpen(false); }, [editable]);
  const library = useRef<LibraryItems>([]);
  const libraryWriting = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const desktop = !!desktopBridge() || (typeof window !== 'undefined' && window.location.protocol === 'file:');
  const latest = useRef({ editable, onSave, mounted: true });
  latest.current = { editable, onSave, mounted: latest.current.mounted };
  useEffect(() => { latest.current.mounted = true; return () => { latest.current.mounted = false; }; }, []);
  const [initial] = useState(() => structuredClone(scene));
  const initialScene = useRef<string | null>(null);
  const observed = useRef<DrawingScene | null>(null);
  const applying = useRef(false);
  const finishRemote = useRef<(() => void) | null>(null);
  const wasEditingText = useRef(false);
  const page = useContext(DrawingPageContext);
  const presence = useRef<ReturnType<typeof bindDrawingPresence> | null>(null);
  useEffect(() => {
    if (!live || !api || !editable || !page?.connected || !page.provider?.awareness) return;
    const binding = bindDrawingPresence(page.provider.awareness, api, drawingNamespace(live.doc, live.base), () => live.valid());
    presence.current = binding;
    return () => { presence.current = null; binding.dispose(); };
  }, [live, api, editable, page?.connected, page?.provider]);
  useEffect(() => { if (live) setDraftTitle(title ?? ''); }, [live, title]);
  useEffect(() => {
    if (!live || !api || !runtime) return;
    const receive = (_update?: Uint8Array, origin?: unknown) => {
      if (origin === live.origin || origin === 'drawing-preview' || !live.valid()) return;
      try {
        const next = live.read().scene;
        const restored = runtime.restoreElements(next.elements as unknown as ExcalidrawElement[], null);
        const state = api.getAppState();
        const active = new Set(state.cursorButton === 'down' ? Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id]) : []);
        for (const element of [state.editingTextElement, state.resizingElement, state.newElement]) if (element) active.add(element.id);
        const local = api.getSceneElements().filter(element => active.has(element.id) || (element.type === 'text' && element.containerId && active.has(element.containerId)));
        const protectedIds = new Set(local.map(element => element.id));
        // Yjs is the conflict authority, except while this SDK owns a gesture.
        // Do not feed inactive local versions into SDK version reconciliation.
        const remote = restored.filter(element => !protectedIds.has(element.id));
        const elements = runtime.reconcileElements(local, remote as unknown as Parameters<typeof runtime.reconcileElements>[1], state);
        // Excalidraw mutates elements during dragging. A shared reference here
        // makes the comparison baseline move too, hiding intermediate edits.
        // Keep the old baseline for protected elements so a remote render cannot
        // swallow local mutations whose onChange notification is still pending.
        const previous = new Map(observed.current?.elements.map(element => [element.id, element]));
        observed.current = structuredClone({ ...next, elements: elements.flatMap<unknown>(element =>
          protectedIds.has(element.id) ? (previous.has(element.id) ? [previous.get(element.id)!] : []) : [element]) }) as unknown as DrawingScene;
        applying.current = true;
        api.addFiles(Object.values(next.files) as unknown as Parameters<typeof api.addFiles>[0]);
        api.updateScene({ elements, appState: next.appState, captureUpdate: runtime.CaptureUpdateAction.NEVER });
        api.history.clear();
      } catch { setError(t.drawingError); }
      finally { applying.current = false; }
    };
    // initialData is restored by the SDK itself. Restoring the legacy base a
    // second time here generates different nonces and looks like a local edit.
    // Only catch up when the CRDT changed while the SDK was loading.
    const catchUp = requestAnimationFrame(() => {
      try { if (JSON.stringify(live.read().scene) !== JSON.stringify(initial)) receive(); }
      catch { setError(t.drawingError); }
    });
    live.doc.on('update', receive);
    let released = 0;
    const settle = () => { cancelAnimationFrame(released); released = requestAnimationFrame(() => receive()); };
    finishRemote.current = settle;
    window.addEventListener('pointerup', settle);
    window.addEventListener('pointercancel', settle);
    return () => {
      cancelAnimationFrame(catchUp); cancelAnimationFrame(released); live.doc.off('update', receive);
      finishRemote.current = null;
      window.removeEventListener('pointerup', settle); window.removeEventListener('pointercancel', settle);
    };
  }, [live, api, runtime, t.drawingError]);

  useEffect(() => {
    if (!live || !runtime || !editable) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const current = live.read();
        if (current.preview || !current.scene.elements.some(element => !element.isDeleted)) return;
        const source = current.scene;
        drawingSceneSchema.parse(source);
        const canvas = await runtime.exportToCanvas({
          elements: runtime.restoreElements(source.elements as unknown as ExcalidrawElement[], null),
          appState: { ...source.appState, exportWithDarkMode: false, exportBackground: true },
          files: source.files as unknown as BinaryFiles, maxWidthOrHeight: MAX_DRAWING_PREVIEW_DIMENSION,
        });
        const preview = drawingPreviewSchema.parse({ mimeType: 'image/png',
          data: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
          width: canvas.width, height: canvas.height, sceneDigest: await drawingSceneDigest(source) });
        if (active) live.preview(source, preview);
      } catch (cause) { if (active) setError(cause instanceof Error && cause.message === 'drawing-retention-limit' ? t.drawingRetention : t.drawingFailed); }
    }, 800);
    return () => { active = false; clearTimeout(timer); };
  }, [live, runtime, scene, editable, t.drawingFailed]);

  function undoDrawing(redo = false) {
    if (!live?.valid()) return;
    live.undo.stopCapturing();
    if (redo) live.undo.redo(); else live.undo.undo();
  }
  useEffect(() => {
    let active = true;
    loadDrawingRuntime().then(value => { if (active) setRuntime(value); })
      .catch(() => { if (active) setError(t.drawingFailed); });
    return () => { active = false; };
  }, [t.drawingFailed]);

  useEffect(() => {
    if (!api || !libraryTarget || !editable) return;
    let active = true;
    setLibraryReady(false);
    try { library.current = initializeLibrary(libraryTarget.key); }
    catch { setError(t.libraryStorageFailed); return; }
    libraryWriting.current = true;
    void api.updateLibrary({ libraryItems: library.current, merge: false }).then(() => {
      if (active) { libraryWriting.current = false; setLibraryReady(true); }
    }).catch(() => { if (active) setError(t.libraryFailed); });
    return () => { active = false; };
  }, [api, libraryTarget?.key, editable]);

  async function install(items: LibraryItems) {
    if (!api || !runtime || !libraryTarget || !latest.current.editable || !latest.current.mounted) return;
    if (!desktop && window.location.pathname !== libraryTarget.path) return;
    if (!items.length) throw new Error('library-empty');
    const restored = runtime.restoreLibraryItems(items, 'published');
    if (restored.length !== items.length || restored.some((item, index) => item.elements.length !== items[index].elements.length)) {
      throw new Error('library-data');
    }
    const merged = mergeLibraries(library.current, validateLibraryItems(restored));
    libraryWriting.current = true;
    try {
      const stored = persistLibrary(libraryTarget.key, library.current, merged);
      library.current = stored;
      await api.updateLibrary({ libraryItems: stored, merge: false, openLibraryMenu: true });
      if (latest.current.mounted) { setError(''); setNotice(t.libraryInstalled); }
    } finally { libraryWriting.current = false; }
  }

  function importError(cause: unknown) {
    setNotice('');
    setError(cause instanceof Error && cause.message === 'library-empty' ? t.libraryEmpty :
      cause instanceof Error && (['library-data', 'library-assets', 'library-size'].includes(cause.message) ||
        cause.name === 'ZodError' || cause.name === 'SyntaxError') ? t.libraryInvalid : t.libraryFailed);
  }

  function libraryChanged(items: LibraryItems) {
    if (!libraryReady || libraryWriting.current || !libraryTarget || !latest.current.editable) return;
    try {
      const next = validateLibraryItems(items);
      persistLibrary(libraryTarget.key, library.current, next);
      // Track what THIS editor saw, not unseen items merged from another tab.
      // Otherwise its next change would mistake those unseen items for deletions.
      library.current = next;
    } catch {
      setError(t.libraryStorageFailed);
      if (api) {
        libraryWriting.current = true;
        void api.updateLibrary({ libraryItems: library.current, merge: false })
          .finally(() => { libraryWriting.current = false; }).catch(() => {});
      }
    }
  }

  async function importFile(file: File) {
    if (!editable || libraryBusy || !libraryReady) return;
    setLibraryBusy(true); setNotice('');
    try {
      if (file.size > LIBRARY_BYTES) throw new Error('library-size');
      await install(parseLibrary(await file.text()));
    } catch (cause) { if (latest.current.mounted) importError(cause); }
    finally { if (latest.current.mounted) setLibraryBusy(false); }
  }

  function browse() {
    if (!api || !libraryTarget || !editable || !libraryReady || libraryBusy || saving) return;
    if (desktop) { window.open('https://libraries.excalidraw.com', '_blank', 'noopener,noreferrer'); return; }
    setError(''); setNotice(''); setCatalogOpen(true);
  }

  async function save() {
    if (!editable || !api || !runtime || saving || libraryBusy) return;
    const elements = api.getSceneElements();
    const fileIds = new Set<string>();
    for (const element of elements) {
      if (element.type === 'image' && !element.isDeleted && element.fileId) fileIds.add(element.fileId);
    }
    // Excalidraw retains deleted assets for its local undo history. Persist
    // only live references so deleting an unsupported/oversized image recovers.
    const files = Object.fromEntries(Object.entries(api.getFiles()).filter(([id]) => fileIds.has(id)));
    const result = drawingSceneSchema.safeParse({
      version: 1,
      elements,
      appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
      files,
    });
    const name = drawingTitleSchema.safeParse(draftTitle);
    if (!result.success || !name.success) { setError(t.drawingError); return; }
    const nextTitle = name.data || (title === undefined ? undefined : '');
    // The SDK restores default element fields on load. Compare against its
    // first scene notification too, so a rename does not persist those defaults.
    const unchanged = JSON.stringify(result.data) === JSON.stringify(drawingSceneSchema.parse(scene)) ||
      (JSON.stringify(initial) === JSON.stringify(scene) && JSON.stringify(result.data) === initialScene.current);
    if (draftTitle !== (title ?? '') && unchanged) {
      if (!onSave(scene, savedPreview, nextTitle)) setError(t.drawingConflict);
      return;
    }
    if (!result.data.elements.some(element => !element.isDeleted)) {
      if (!onSave(result.data, undefined, nextTitle)) setError(t.drawingConflict);
      return;
    }
    setSaving(true);
    try {
      const canvas = await runtime.exportToCanvas({
        elements: runtime.restoreElements(result.data.elements as unknown as ExcalidrawElement[], null),
        appState: { ...result.data.appState, exportWithDarkMode: false, exportBackground: true },
        files: result.data.files as unknown as BinaryFiles,
        maxWidthOrHeight: MAX_DRAWING_PREVIEW_DIMENSION,
      });
      const preview = drawingPreviewSchema.parse({ mimeType: 'image/png',
        data: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
        width: canvas.width, height: canvas.height, sceneDigest: await drawingSceneDigest(result.data) });
      if (!latest.current.mounted) return;
      if (!latest.current.editable || !latest.current.onSave(result.data, preview, nextTitle)) setError(t.drawingConflict);
    } catch { if (latest.current.mounted) setError(t.drawingFailed); }
    finally { if (latest.current.mounted) setSaving(false); }
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm" />
      {/* Excalidraw finishes gestures in native window pointerup listeners.
          Keep pointer/mouse events bubbling; DrawingToolbarProvider hides host UI. */}
      <Dialog.Popup
        className="fixed inset-0 z-50 flex flex-col bg-background text-foreground sm:inset-4 sm:rounded-xl sm:border sm:border-border"
        onKeyDown={event => event.stopPropagation()}
        onKeyDownCapture={event => {
          if (!live || !(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase()) ||
            (event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
          event.preventDefault(); event.stopPropagation();
          undoDrawing(event.shiftKey || event.key.toLowerCase() === 'y');
        }}
        onKeyUp={event => event.stopPropagation()}
        onWheel={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
          <Dialog.Title className="sr-only">{draftTitle.trim() || t.drawing}</Dialog.Title>
          <input aria-label={t.drawingName} className="mr-auto min-w-0 basis-40 flex-1 rounded border border-transparent bg-transparent px-1 py-1 font-semibold hover:border-border focus:border-border focus:outline-none focus:ring-2 focus:ring-ring"
            value={draftTitle} maxLength={200} disabled={!editable || saving || libraryBusy} placeholder={t.drawing}
            onFocus={() => { titleBeforeFocus.current = draftTitle; }}
            onChange={event => setDraftTitle(event.target.value)}
            onBlur={event => {
              try { if (live && !live.rename(event.target.value)) setError(t.drawingConflict); }
              catch (cause) { setError(cause instanceof Error && cause.message === 'drawing-retention-limit' ? t.drawingRetention : t.drawingError); }
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              if (event.key === 'Escape') {
                const reverted = live ? live.read().title ?? '' : titleBeforeFocus.current;
                setDraftTitle(reverted); event.currentTarget.value = reverted;
              }
              event.currentTarget.blur();
            }} />
           {libraryTarget && <>
             <Button variant="outline" disabled={!editable || !libraryReady || libraryBusy || saving} onClick={browse}>{t.libraryBrowse}</Button>
             <Button variant="outline" disabled={!editable || !libraryReady || libraryBusy || saving} onClick={() => fileInput.current?.click()}>{t.libraryImport}</Button>
             <input ref={fileInput} type="file" accept=".excalidrawlib" hidden onChange={event => {
               const file = event.target.files?.[0]; event.target.value = '';
               if (file) void importFile(file);
             }} />
           </>}
           {live && <>
             <Button variant="outline" disabled={!editable} onClick={() => undoDrawing()}>{t.drawingUndo}</Button>
             <Button variant="outline" disabled={!editable} onClick={() => undoDrawing(true)}>{t.drawingRedo}</Button>
           </>}
           <Button variant="outline" onClick={onCancel}>{live ? t.drawingClose : t.cancel}</Button>
           {!live && <Button disabled={!editable || !api || saving || libraryBusy} onClick={save}>{t.drawingSave}</Button>}
           <Dialog.Description className="w-full text-xs text-muted-foreground">{live ? t.drawingLiveHelp : t.drawingHelp}</Dialog.Description>
           {libraryTarget && <p className="w-full text-xs text-muted-foreground">{desktop ? t.libraryDesktop : t.libraryLocal}</p>}
           {libraryTarget && !desktop && <p className="w-full text-xs text-muted-foreground">{isLocalLibraryOrigin(window.location.href) ? t.libraryPickerHelp : t.libraryReturnHelp}</p>}
           {notice && <p role="status" className="w-full text-sm">{notice}</p>}
           {libraryBusy && <p role="status" className="w-full text-sm">{t.libraryLoading}</p>}
          {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
        </div>
        {/* The empty MainMenu override suppresses SDK defaults; hide its otherwise empty popup trigger. */}
        <div className={`min-h-0 flex-1 [&_.library-menu-browse-button]:hidden [&_.main-menu-trigger]:hidden! ${live ? '[&_.undo-redo-buttons]:hidden!' : ''}`}
          onClickCapture={event => {
            if ((event.target as Element).closest('.library-menu-browse-button')) {
              event.preventDefault(); event.stopPropagation(); browse();
              return;
            }
            if ((event.target as Element).closest('[data-testid="lib-dropdown--load"]')) {
              event.preventDefault(); event.stopPropagation();
              if (editable && libraryReady && !libraryBusy) fileInput.current?.click();
            }
          }}
          onDropCapture={event => {
            const file = event.dataTransfer.files[0];
            if (file && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
              event.preventDefault(); event.stopPropagation();
              if (file.name.endsWith('.excalidrawlib')) void importFile(file);
              else setError(t.libraryFailed);
            }
            const data = event.dataTransfer.getData('application/vnd.excalidrawlib+json');
            if (data) {
              try { parseLibrary(data); }
              catch { event.preventDefault(); event.stopPropagation(); setError(t.libraryFailed); }
            }
          }}>
          {runtime ? <runtime.Excalidraw
            excalidrawAPI={setApi}
            onLibraryChange={libraryChanged}
            onPointerDown={() => live?.undo.stopCapturing()}
            onPointerUpdate={payload => presence.current?.pointer(payload)}
            onChange={(elements, appState, files) => {
              presence.current?.selection(appState);
              if (wasEditingText.current && !appState.editingTextElement) finishRemote.current?.();
              wasEditingText.current = !!appState.editingTextElement;
              if (!live && initialScene.current !== null) return;
              const ids = new Set<string>(elements.flatMap(element => element.type === 'image' && !element.isDeleted && element.fileId ? [element.fileId] : []));
              const input = { version: 1, elements: live ? elements.filter(element => !element.isDeleted) : elements,
                appState: { viewBackgroundColor: appState.viewBackgroundColor },
                files: Object.fromEntries(Object.entries(files).filter(([id]) => ids.has(id))) };
              if (!live) {
                const parsed = drawingSceneSchema.safeParse(input);
                if (parsed.success && initialScene.current === null) initialScene.current = JSON.stringify(parsed.data);
                return;
              }
              if (live) {
                try {
                  const next = parseDrawingSceneStructure(input);
                  const previous = observed.current;
                  if (applying.current || !previous) {
                    observed.current = structuredClone(next);
                    if (!drawingSceneSchema.safeParse(live.read().scene).success) setError(t.drawingError);
                    return;
                  }
                  if (JSON.stringify(previous) === JSON.stringify(next)) return;
                  if (!live.write(previous, next)) setError(t.drawingConflict);
                  else { observed.current = structuredClone(next); setError(''); }
                } catch (cause) { setError(cause instanceof Error && cause.message === 'drawing-retention-limit' ? t.drawingRetention : t.drawingError); }
                api?.history.clear();
              }
            }}
            initialData={{ ...initial, appState: { ...initial.appState, currentItemFontFamily: runtime.FONT_FAMILY.Nunito }, scrollToContent: true } as unknown as ExcalidrawInitialDataState}
            theme={resolved}
            langCode={locale === 'ja' ? 'ja-JP' : locale === 'zh' ? 'zh-TW' : locale === 'zh-CN' ? 'zh-CN' : 'en'}
            viewModeEnabled={!editable || saving || libraryBusy}
            isCollaborating={!!live}
            handleKeyboardGlobally={false}
            autoFocus
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false }, tools: { image: true } }}
          ><runtime.MainMenu /></runtime.Excalidraw> : <p role="status" className="p-4">{t.drawingLoading}</p>}
        </div>
        {catalogOpen && editable && libraryTarget && !desktop && <DrawingLibraryCatalog theme={resolved}
          path={libraryTarget.path} onClose={() => setCatalogOpen(false)} onImport={install} />}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
