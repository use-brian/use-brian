"use client";

/**
 * Recording detail — `/w/[workspaceId]/recordings/[recordingId]`.
 *
 * The home for a recording that has NO brief page: synthesis is opt-in on
 * `blueprintSlug`, so an ingest-only upload produces no doc at all, and this is
 * the only place it can be played and read. It is also the landing for a
 * `#t=<seconds>` deep link shared out of context, and the target the recordings
 * board's rows navigate to.
 *
 * When a recording DOES have a brief, that page is the primary surface — it
 * mounts the same player, transcript and action items as chrome (see
 * `components/recordings/recording-chrome.tsx`). This route deliberately shares
 * those components rather than reimplementing them; two copies of a player
 * would drift.
 *
 * A real route rather than a doc-shell panel: panels (`/p?panel=…`) are boards,
 * and this is a single artifact with its own URL that other pages link INTO.
 *
 * [COMP:app-web/recording-detail]
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { getRecording, type RecordingSummary } from "@/lib/api/recordings";
import { RecordingPlayerProvider } from "@/lib/recordings/recording-player-context";
import { RecordingPlayerBar } from "@/components/recordings/recording-player-bar";
import { TranscriptPane } from "@/components/recordings/transcript-pane";
import { ActionItemsRail } from "@/components/recordings/action-items-rail";
import { HashSeek } from "@/components/recordings/recording-chrome";

export default function RecordingDetailPage() {
  const t = useT();
  const params = useParams<{ workspaceId: string; recordingId: string }>();
  const [rec, setRec] = useState<RecordingSummary | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    getRecording(params.recordingId)
      .then((r) => live && setRec(r))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [params.recordingId]);

  if (missing) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">{t.recordings.detailNotFound}</p>
      </main>
    );
  }

  const statusNote =
    rec?.status === "queued"
      ? t.recordings.detailStatusQueued
      : rec?.status === "processing"
        ? t.recordings.detailStatusProcessing
        : rec?.status === "failed"
          ? t.recordings.detailStatusFailed
          : null;

  const title = rec?.title ?? rec?.fileName ?? "";

  return (
    <RecordingPlayerProvider recordingId={params.recordingId} durationMs={rec?.durationMs ?? 0}>
      <HashSeek />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <Link
          href={`/w/${params.workspaceId}/p`}
          className="text-xs text-muted-foreground hover:underline"
        >
          {t.recordings.detailBack}
        </Link>
        <h1 className="text-xl font-semibold">{title}</h1>

        {statusNote ? <p className="text-sm text-muted-foreground">{statusNote}</p> : null}
        {rec?.truncated ? (
          <p className="text-sm text-muted-foreground">{t.recordings.detailTruncated}</p>
        ) : null}

        <RecordingPlayerBar title={title} className="sticky top-0 z-10" />

        <section>
          <h2 className="mb-2 text-sm font-medium">{t.recordings.actionItemsTitle}</h2>
          <ActionItemsRail
            recordingId={params.recordingId}
            workspaceId={params.workspaceId}
          />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium">{t.recordings.detailTranscript}</h2>
          <TranscriptPane recordingId={params.recordingId} />
        </section>
      </main>
    </RecordingPlayerProvider>
  );
}
