"use client";

/**
 * The recording surface on a BRIEF PAGE: the player, the action items, and the
 * transcript, mounted above the doc when the page was synthesized from a
 * recording.
 *
 * Why here and not on a separate route: the brief IS where a user lands after
 * an upload, so making them navigate elsewhere to play the audio they just gave
 * us is the whole complaint. The standalone `/w/<wid>/recordings/<id>` route
 * stays - it is the home for a recording with NO brief (synthesis is opt-in on
 * `blueprintSlug`, so an ingest-only upload has no page at all) and the target
 * of a `#t=<seconds>` deep link shared out of context.
 *
 * **All of it is chrome, never doc blocks.** It renders outside the
 * ProseMirror editor: a block is user-editable content they could delete,
 * orphaning every citation on the page, and it would enter the Yjs doc (which
 * `schema.ts` warns needs a lockstep doc-sync + web deploy). Nothing here
 * touches the document.
 *
 * Layout: the action items are ALWAYS open - they are the thing a person acts
 * on after a meeting, and hiding them behind a toggle buried the point of the
 * page. The transcript is a labelled disclosure instead: it is reference
 * material you consult, and a 96-minute meeting's worth of it above the summary
 * would bury the brief the page exists to show.
 *
 * Spec: docs/architecture/media/recordings.md -> "The brief page IS the
 * recording surface".
 *
 * [COMP:app-web/recording-chrome]
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatStamp } from "@sidanclaw/shared";
import { useT } from "@/lib/i18n/client";
import { useRecordingPlayer } from "@/lib/recordings/recording-player-context";
import { RecordingPlayerBar } from "./recording-player-bar";
import { TranscriptPane } from "./transcript-pane";
import { ActionItemsRail } from "./action-items-rail";

/**
 * The transcript card a citation pops. Fixed to the viewport bottom-right, so
 * it reads next to the claim rather than scrolling the brief away, and it never
 * depends on where in the page the citation happened to sit.
 *
 * Dismisses on Escape and on its own close button. Deliberately NOT a modal:
 * the whole point is to read the transcript AGAINST the sentence that cited it,
 * so the brief must stay visible and interactive behind it.
 */
function CitationTranscriptCard({ recordingId }: { recordingId: string }) {
  const t = useT();
  const { transcriptFocus, clearTranscriptFocus } = useRecordingPlayer();

  useEffect(() => {
    if (!transcriptFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearTranscriptFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [transcriptFocus, clearTranscriptFocus]);

  if (!transcriptFocus) return null;

  return (
    <aside
      role="dialog"
      aria-label={t.recordings.detailTranscript}
      className="fixed bottom-4 right-4 z-50 flex max-h-[60vh] w-[min(26rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-background shadow-lg"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">
          {t.recordings.detailTranscript}
          <span className="ml-2 tabular-nums text-xs text-muted-foreground">
            {formatStamp(transcriptFocus.ms)}
          </span>
        </span>
        <button
          type="button"
          onClick={clearTranscriptFocus}
          aria-label={t.recordings.citationCardClose}
          className="rounded px-1.5 text-sm text-muted-foreground hover:bg-muted"
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <TranscriptPane
          recordingId={recordingId}
          focusMs={transcriptFocus.ms}
          focusNonce={transcriptFocus.nonce}
        />
      </div>
    </aside>
  );
}

/** Reads `#t=<seconds>` on mount — the citation deep link's landing. */
export function HashSeek() {
  const { seekTo, recordingId } = useRecordingPlayer();
  useEffect(() => {
    if (!recordingId) return;
    const m = /^#t=(\d+(?:\.\d+)?)$/.exec(window.location.hash);
    if (m) seekTo(Number(m[1]) * 1000);
  }, [seekTo, recordingId]);
  return null;
}

export function RecordingChrome({
  recordingId,
  workspaceId,
  title,
}: {
  recordingId: string;
  workspaceId: string;
  title: string;
}) {
  const t = useT();
  const [showTranscript, setShowTranscript] = useState(false);

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <HashSeek />
      {/* Popped by a `[H:MM:SS]` citation in the prose below. */}
      <CitationTranscriptCard recordingId={recordingId} />
      <RecordingPlayerBar title={title} className="sticky top-0 z-10" />

      {/* Always open — the reason someone opens a meeting page. */}
      <section>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{t.recordings.actionItemsTitle}</h2>
          <Link
            href={`/w/${workspaceId}/recordings/${recordingId}`}
            className="shrink-0 text-xs text-muted-foreground hover:underline"
          >
            {t.recordings.chromeOpenRecording}
          </Link>
        </div>
        <ActionItemsRail recordingId={recordingId} workspaceId={workspaceId} />
      </section>

      {/* Reference material — one click away, never in front of the brief. */}
      <section className="border-t border-border pt-2">
        <button
          type="button"
          onClick={() => setShowTranscript((v) => !v)}
          aria-expanded={showTranscript}
          className="flex w-full items-center gap-2 text-left text-sm font-medium hover:text-foreground/80"
        >
          <span
            aria-hidden
            className={`inline-block transition-transform ${showTranscript ? "rotate-90" : ""}`}
          >
            ▸
          </span>
          {t.recordings.detailTranscript}
        </button>
        {showTranscript ? (
          <div className="mt-2 max-h-96 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
            <TranscriptPane recordingId={recordingId} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
