"use client";

import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { drawingLibraryMessageSchema } from '@use-brian/shared/drawing';
import { useT } from '@/lib/i18n/client';
import { Button } from '@/components/ui/button';
import { fetchLibrary, fetchLibraryIndex, officialLibraryUrl, isLocalLibraryOrigin } from './drawing-library';

export function DrawingLibraryCatalog({ theme, path, onClose, onImport }: {
  theme: string; path: string; onClose: () => void;
  onImport: (items: LibraryItems) => Promise<void>;
}) {
  const t = useT().docPage.diagramSource;
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef<AbortController | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const local = isLocalLibraryOrigin(window.location.href);
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof fetchLibraryIndex>>>([]);
  const [search, setSearch] = useState('');
  const [brokenPreviews, setBrokenPreviews] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState(0);
  const select = useRef<(url: string) => void>(() => {});
  const [token] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
  const latest = useRef({ onImport, onClose });
  latest.current = { onImport, onClose };
  const origin = window.location.origin;
  const supported = ['http:', 'https:'].includes(window.location.protocol) && origin !== 'null';
  const url = new URL('https://libraries.excalidraw.com');
  url.search = new URLSearchParams({ referrer: `${origin}/drawing-library-callback.html`, target: '_self',
    useHash: 'true', token, theme, version: '2' }).toString();
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    request.current = controller;
    let claimed = false;
    const expires = Date.now() + 60 * 60 * 1000;
    let available: Awaited<ReturnType<typeof fetchLibraryIndex>> = [];
    const install = async (url: string) => {
      if (claimed || controller.signal.aborted || Date.now() >= expires || window.location.pathname !== path) return;
      try { officialLibraryUrl(url); } catch { return; }
      claimed = true; setBusy(true); setFailed(false);
      try {
        const items = await fetchLibrary(url, controller.signal);
        if (controller.signal.aborted || window.location.pathname !== path) return;
        await latest.current.onImport(items);
        if (!controller.signal.aborted) latest.current.onClose();
      } catch { if (!controller.signal.aborted) { claimed = !local; setFailed(true); setBusy(false); } }
    };
    const receive = (event: MessageEvent) => {
      if (local || event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const parsed = drawingLibraryMessageSchema.safeParse(event.data);
      if (parsed.success && parsed.data.token === token) void install(parsed.data.url);
    };
    if (local) {
      setLoaded(false); setFailed(false); setEntries([]);
      select.current = url => { if (available.some(entry => entry.url === url)) void install(url); };
      void fetchLibraryIndex(controller.signal).then(value => {
        if (!controller.signal.aborted) { available = value; setEntries(value); setLoaded(true); }
      }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setLoaded(true); } });
    } else window.addEventListener('message', receive);
    return () => { controller.abort(); select.current = () => {}; window.removeEventListener('message', receive); };
  }, [token, origin, path, supported, local, retry]);
  function dismiss() { request.current?.abort(); onClose(); }
  const matches = entries.filter(entry => `${entry.name} ${entry.authors}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <Dialog.Root open onOpenChange={open => { if (!open) dismiss(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop forceRender className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm dark:bg-background/80" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex h-[calc(100dvh-1rem)] max-h-[56rem] w-[calc(100%-1rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl ring-1 ring-foreground/20 sm:h-[calc(100dvh-4rem)] sm:w-[calc(100%-4rem)]">
        <div className="flex max-h-[50%] shrink-0 flex-wrap items-center gap-2 overflow-y-auto border-b border-border p-3">
          <Dialog.Title className="mr-auto font-semibold">{t.libraryBrowse}</Dialog.Title>
          <Button variant="outline" onClick={dismiss}>{t.close}</Button>
          <Dialog.Description className="w-full text-sm text-muted-foreground">{local ? t.libraryPickerHelp : t.libraryReturnHelp}</Dialog.Description>
          {(!loaded || busy) && !failed && <p role="status">{busy ? t.libraryLoading : t.libraryCatalogLoading}</p>}
          {(failed || !supported) && <p role="alert" className="text-destructive">{local && !entries.length ? t.libraryCatalogFailed : t.libraryFailed}</p>}
          {local && failed && entries.length === 0 && <Button variant="outline" onClick={() => setRetry(value => value + 1)}>{t.libraryRetry}</Button>}
        </div>
        {supported && local && <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <label className="flex flex-col gap-1 text-sm">{t.librarySearch}
            <input type="search" value={search} maxLength={200} onChange={event => setSearch(event.target.value)}
              className="min-h-11 rounded border border-border bg-background px-3 py-2 text-base sm:min-h-0 sm:text-sm" />
          </label>
          <p className="text-xs text-muted-foreground">{t.libraryPreviewHelp}</p>
          <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain" aria-busy={busy}>
            {matches.map(entry =>
              <li key={entry.url} className="flex flex-wrap items-center gap-3 rounded border border-border p-3">
                <div className="flex h-28 w-full shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40 sm:w-44">
                  {entry.preview && !brokenPreviews.has(entry.preview) ? <img src={entry.preview}
                    alt={`${t.libraryPreview}: ${entry.name}`} loading="lazy" decoding="async" referrerPolicy="no-referrer"
                    className="h-full w-full object-contain" onError={() => setBrokenPreviews(previous => new Set(previous).add(entry.preview!))} />
                    : <span className="px-2 text-center text-xs text-muted-foreground">{t.libraryPreviewUnavailable}</span>}
                </div>
                <div className="min-w-0 flex-1 break-words"><p className="font-medium">{entry.name}</p><p className="text-sm text-muted-foreground">{entry.authors}</p></div>
                <Button variant="outline" disabled={busy} onClick={() => select.current(entry.url)} aria-label={`${t.libraryImport}: ${entry.name}`}>{t.libraryImport}</Button>
              </li>)}
            {loaded && !failed && !matches.length && <li role="status">{t.libraryNoResults}</li>}
          </ul>
        </div>}
        {supported && !local && !failed && <iframe ref={frame} title={t.libraryBrowse} src={url.href}
          sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
