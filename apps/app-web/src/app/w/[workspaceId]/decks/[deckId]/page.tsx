"use client";

/**
 * Deck live preview — /w/[workspaceId]/decks/[deckId].
 *
 * Renders the deck's slides straight from its spec via the shared layout
 * engine (no pptx rasterization anywhere), refreshes on the `deck`
 * workspace event (so every updatePowerpoint edit appears live while the
 * user iterates in the chat dock), and offers the .pptx download. Writes
 * happen only through chat — this page is a viewer.
 *
 * Spec: docs/architecture/features/deck-generation.md. [COMP:app-web/decks]
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutDeck, resolveDeckStyle } from "@sidanclaw/shared/decks";
import { DeckSlide, deckSlideHeightPx } from "@/components/decks/deck-slide";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { downloadDeckExport, getDeck, type DeckDetail } from "@/lib/api/decks";
import { DECK_REFRESH_EVENT, type DeckRefreshDetail } from "@/lib/deck-events";
import { useT } from "@/lib/i18n/client";

const THUMB_WIDTH = 168;

export default function DeckPreviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string; deckId: string }>;
}) {
  const t = useT();
  const { workspaceId, deckId } = use(params);

  const [deck, setDeck] = useState<DeckDetail | null | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  const refetch = useCallback(async () => {
    const next = await getDeck(deckId);
    setDeck(next);
  }, [deckId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Live refresh: the workspace event spine dispatches this for `deck`
  // change signals from any lane (chat, callee, workflow, another tab).
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<DeckRefreshDetail>).detail;
      if (detail.workspaceId && detail.workspaceId !== workspaceId) return;
      if (detail.rowId && detail.rowId !== deckId) return;
      void refetch();
    };
    window.addEventListener(DECK_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(DECK_REFRESH_EVENT, onRefresh);
  }, [workspaceId, deckId, refetch]);

  const layouts = useMemo(() => {
    if (!deck) return [];
    try {
      return layoutDeck(deck.spec, resolveDeckStyle(deck.spec.theme, deck.style));
    } catch {
      return [];
    }
  }, [deck]);

  // Main canvas width tracks the container (the computer-page scale idiom).
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(960);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setCanvasWidth(Math.min(width, 1400));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [deck === undefined]);

  const safeSelected = Math.min(selected, Math.max(layouts.length - 1, 0));

  if (deck === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t.deckPage.loading}
      </div>
    );
  }
  if (deck === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{t.deckPage.notFound}</p>
        <BackButton label={t.deckPage.back} href={`/w/${workspaceId}/p`} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <BackButton label={t.deckPage.back} href={`/w/${workspaceId}/p`} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{deck.title}</h1>
          <p className="text-xs text-muted-foreground">
            {t.deckPage.slideCount.replace("{count}", String(layouts.length))} · v{deck.version} ·{" "}
            {t.deckPage.liveHint}
          </p>
        </div>
        {downloadError ? (
          <span className="text-xs text-destructive">{t.deckPage.downloadFailed}</span>
        ) : null}
        <Button
          size="sm"
          disabled={downloading}
          onClick={() => {
            setDownloading(true);
            setDownloadError(false);
            void downloadDeckExport(deck.id, deck.title)
              .then((ok) => setDownloadError(!ok))
              .finally(() => setDownloading(false));
          }}
        >
          {t.deckPage.download}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Thumbnail rail */}
        <aside className="w-[200px] shrink-0 overflow-y-auto border-r border-border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t.deckPage.slides}</p>
          <div className="flex flex-col gap-2">
            {layouts.map((layout, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(i)}
                className={
                  "overflow-hidden rounded-md border text-left transition-colors " +
                  (i === safeSelected ? "border-primary" : "border-border hover:border-muted-foreground/40")
                }
                style={{ width: THUMB_WIDTH, height: deckSlideHeightPx(THUMB_WIDTH) }}
                aria-label={`${i + 1}`}
              >
                <DeckSlide layout={layout} widthPx={THUMB_WIDTH} workspaceId={workspaceId} />
              </button>
            ))}
          </div>
        </aside>

        {/* Main canvas */}
        <main ref={canvasRef} className="min-w-0 flex-1 overflow-auto bg-muted/30 p-6">
          {layouts[safeSelected] ? (
            <div
              className="mx-auto overflow-hidden rounded-lg border border-border shadow-sm"
              style={{ width: Math.min(canvasWidth - 48, 1200) }}
            >
              <DeckSlide
                layout={layouts[safeSelected]}
                widthPx={Math.min(canvasWidth - 48, 1200)}
                workspaceId={workspaceId}
              />
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
