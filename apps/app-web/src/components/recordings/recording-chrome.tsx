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
 * **The chrome is status-honest.** A page is linked to its recording the
 * moment the recording id exists (the live-capture auto-link), so the linked
 * recording may still be uploading, queued, processing, or failed. Rendering
 * the processed-state UI for those would invent action items and a transcript.
 * The chrome shows their processing status, but keeps the player available
 * once a positive duration proves that the media reached storage.
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

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatStamp } from "@use-brian/shared";
import { useT } from "@/lib/i18n/client";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { RecordingVideoStage, useRecordingPlayer } from "@/lib/recordings/recording-player-context";
import { dispatchRecordingParticipantsUpdated } from "@/lib/recordings/recording-events";
import {
  updateRecordingParticipants,
  type RecordingSummary,
} from "@/lib/api/recordings";
import { useRecordingSummary } from "@/lib/recordings/use-recording-summary";
import { RecordingPlayerBar } from "./recording-player-bar";
import { TranscriptPane } from "./transcript-pane";
import { ActionItemsRail } from "./action-items-rail";

/**
 * The transcript card a citation pops. Fixed above the chat dock at the
 * viewport bottom-right, so it reads next to the claim rather than scrolling
 * the brief away - and never sits ON the dock's "Ask anything" pill, which
 * shares that corner (the bottom offset clears it).
 *
 * Dismisses on Escape and on its own close button. Deliberately NOT a modal:
 * the whole point is to read the transcript AGAINST the sentence that cited it,
 * so the brief must stay visible and interactive behind it.
 *
 * Exported for the shared-page chrome (`public-recording-chrome.tsx`), which
 * passes its anonymous `fetchTranscriptPage` — the card itself is identical on
 * both surfaces, so a second copy would drift.
 */
export function CitationTranscriptCard({
  recordingId,
  fetchTranscriptPage,
  emptyCopy,
}: {
  recordingId: string;
  /** Forwarded to `TranscriptPane` — absent means the authed read. */
  fetchTranscriptPage?: Parameters<typeof TranscriptPane>[0]["fetchPage"];
  /** Status-honest empty state ("still processing") instead of the generic one. */
  emptyCopy?: string;
}) {
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
      className="fixed bottom-24 right-4 z-50 flex max-h-[55dvh] w-[min(26rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-background shadow-lg"
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
          className="inline-flex h-11 w-11 items-center justify-center rounded text-sm text-muted-foreground hover:bg-muted sm:h-7 sm:w-7"
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <TranscriptPane
          recordingId={recordingId}
          focusMs={transcriptFocus.ms}
          focusNonce={transcriptFocus.nonce}
          {...(fetchTranscriptPage ? { fetchPage: fetchTranscriptPage } : {})}
          {...(emptyCopy ? { emptyCopy } : {})}
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

type RecordingChromeProps = {
  recordingId: string;
  workspaceId: string;
  title: string;
  /** Originating page for the standalone view's return link. */
  pageId?: string;
  /** Only manually linked recordings may be unlinked. */
  onUnlink?: () => void;
  /** Provisional live transcript, replaced by the final transcript on completion. */
  livePane?: React.ReactNode;
};

export function RecordingChrome(props: RecordingChromeProps) {
  const { summary } = useRecordingSummary(props.workspaceId, props.recordingId);
  return <RecordingChromeContent key={props.recordingId} {...props} summary={summary} />;
}

/** One status/player/transcript surface for the page and standalone route. */
export function RecordingChromeContent({
  recordingId,
  workspaceId,
  title,
  pageId,
  onUnlink,
  livePane,
  summary,
  standalone = false,
}: RecordingChromeProps & {
  summary: RecordingSummary | null;
  standalone?: boolean;
}) {
  const t = useT();
  const [showTranscript, setShowTranscript] = useState(standalone);
  const recordingHref = `/w/${workspaceId}/recordings/${recordingId}${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`;

  const handleRenameSpeaker = useCallback(
    async (speaker: string) => {
      if (!summary) return;
      const existing = summary.participants.find((p) => p.speaker === speaker);
      const name = await promptDialog({
        title: t.recordings.speakerRenameTitle,
        description: t.recordings.speakerRenameBody.replace("{speaker}", speaker),
        defaultValue: existing?.name ?? "",
        confirmLabel: t.recordings.speakerRenameAction,
      });
      if (name === null) return;
      const kept = summary.participants
        .filter((p) => p.speaker !== speaker)
        .map((p) => ({ speaker: p.speaker, ...(p.name ? { name: p.name } : {}) }));
      const next = [
        ...kept,
        { speaker, ...(name.trim() ? { name: name.trim() } : {}) },
      ];
      try {
        await updateRecordingParticipants(recordingId, next);
        dispatchRecordingParticipantsUpdated({ recordingId });
      } catch {
        // Non-fatal — the transcript keeps its stable labels.
      }
    },
    [summary, recordingId, t],
  );

  const status = summary?.status;
  const notProcessed = status !== undefined && status !== "processed";
  // Preserve playback when the metadata read fails: the independently minted
  // media URL can still work. A known unfinished upload needs proven bytes.
  const canPlay = !notProcessed || (summary?.durationMs ?? 0) > 0;

  return (
    <div className="mb-6 flex flex-col gap-3">
      <HashSeek />
      {/* Popped by a `[H:MM:SS]` citation in the prose below. */}
      <CitationTranscriptCard
        recordingId={recordingId}
        {...(notProcessed ? { emptyCopy: t.recordings.transcriptPending } : {})}
      />

      {summary?.truncated ? (
        <p className="text-sm text-muted-foreground">{t.recordings.detailTruncated}</p>
      ) : null}

      {canPlay ? (
        <>
          <RecordingVideoStage />
          <RecordingPlayerBar title={title} className="sticky top-0 z-10" />
        </>
      ) : null}

      {notProcessed ? (
        /* Processing status stays visible beside independently playable media. */
        <section className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">
              {status === "failed"
                ? t.recordings.statusFailedTitle
                : status === "awaiting_upload"
                  ? canPlay
                    ? t.recordings.statusStagedTitle
                    : t.recordings.statusAwaitingUploadTitle
                  : t.recordings.statusProcessingTitle}
            </h2>
            <span className="flex shrink-0 items-center gap-3">
              {onUnlink ? (
                <button
                  type="button"
                  onClick={onUnlink}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {t.recordings.linkUnlink}
                </button>
              ) : null}
              {!standalone ? (
                <Link
                  href={recordingHref}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {t.recordings.chromeOpenRecording}
                </Link>
              ) : null}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {status === "failed"
              ? summary?.lastError
                ? t.recordings.statusFailedBodyDetail.replace("{detail}", summary.lastError)
                : t.recordings.statusFailedBody
              : status === "awaiting_upload"
                ? canPlay
                  ? t.recordings.statusStagedBody
                  : t.recordings.statusAwaitingUploadBody
                : t.recordings.statusProcessingBody}
          </p>
          {livePane}
        </section>
      ) : (
        <>
          {/* Always open — the reason someone opens a meeting page. */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">{t.recordings.actionItemsTitle}</h2>
              <span className="flex shrink-0 items-center gap-3">
                {onUnlink ? (
                  <button
                    type="button"
                    onClick={onUnlink}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    {t.recordings.linkUnlink}
                  </button>
                ) : null}
                {!standalone ? (
                  <Link
                    href={recordingHref}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    {t.recordings.chromeOpenRecording}
                  </Link>
                ) : null}
              </span>
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
              <div className="mt-2 max-h-96 overflow-y-auto rounded-md bg-muted/30 px-3 py-2">
                <TranscriptPane
                  recordingId={recordingId}
                  participants={summary?.participants ?? []}
                  onRenameSpeaker={handleRenameSpeaker}
                />
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
