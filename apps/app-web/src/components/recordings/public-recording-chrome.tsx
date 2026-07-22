"use client";

/**
 * The recording surface on an anonymously SHARED page: the player and the
 * transcript, mounted above the read-only blocks when the page carries a
 * recording — the same chrome the brief page shows in-app, minus everything a
 * public viewer cannot act on.
 *
 * Composes the SAME pieces as `RecordingChrome` (`RecordingPlayerBar`,
 * `TranscriptPane`, `CitationTranscriptCard`, `HashSeek`) rather than copying
 * them — two players would drift. What it deliberately does NOT render:
 *
 *  - the action-items rail — Confirm/Dismiss are brain writes an anonymous
 *    viewer has no authority for, and extracted tasks are internal triage,
 *    not published content;
 *  - "Open recording" / "Unlink" — both point into the authed app.
 *
 * Data flows through the PUBLIC source-scoped endpoints (`lib/api/public-share`
 * `getPublicRecordingMediaUrl` / `getPublicRecordingTranscript`): the share
 * chain is re-resolved server-side per request, so a revoked share cuts the
 * audio and transcript with it.
 *
 * Spec: docs/architecture/media/recordings.md → "The shared page carries the
 * recording too".
 *
 * [COMP:app-web/public-recording-chrome]
 */

import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  getPublicRecordingTranscript,
  type PublicRecording,
  type PublicSource,
} from "@/lib/api/public-share";
import { RecordingPlayerBar } from "./recording-player-bar";
import { TranscriptPane } from "./transcript-pane";
import { CitationTranscriptCard, HashSeek } from "./recording-chrome";

export function PublicRecordingChrome({
  source,
  recording,
  title,
}: {
  source: PublicSource;
  recording: PublicRecording;
  /** The page title — labels the scrubber (the public view has no recording
   *  title of its own; the server deliberately withholds the file name). */
  title: string;
}) {
  const t = useT();
  const [showTranscript, setShowTranscript] = useState(false);

  const fetchTranscriptPage = useCallback(
    (fromIndex: number) => getPublicRecordingTranscript(source, fromIndex),
    // The source object is rebuilt per render by the caller; key on its
    // stable identity fields so the transcript pane doesn't refetch per paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      source.kind,
      source.kind === "link" ? source.token : source.kind === "site" ? source.host : "",
      source.pageId ?? "",
    ],
  );

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <HashSeek />
      {/* Popped by a `[H:MM:SS]` citation in the prose below. */}
      <CitationTranscriptCard recordingId={recording.recordingId} fetchTranscriptPage={fetchTranscriptPage} />
      <RecordingPlayerBar title={title} className="sticky top-0 z-10" />

      {/* Reference material — one click away, never in front of the brief. */}
      <section>
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
            <TranscriptPane recordingId={recording.recordingId} fetchPage={fetchTranscriptPage} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
