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

import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { RecordingPlayerProvider } from "@/lib/recordings/recording-player-context";
import { useRecordingSummary } from "@/lib/recordings/use-recording-summary";
import { RecordingChromeContent } from "@/components/recordings/recording-chrome";
import { RecordingProcessAction } from "@/components/recordings/recording-process-action";
import { ReclassifyContextButton } from "@/components/context/reclassify-context-dialog";

export default function RecordingDetailPage() {
  const t = useT();
  const params = useParams<{ workspaceId: string; recordingId: string }>();
  const searchParams = useSearchParams();
  const pageId = searchParams.get("page");
  const { summary: rec, error, recovery } = useRecordingSummary(
    params.workspaceId,
    params.recordingId,
  );
  const title = rec?.title ?? rec?.fileName ?? "";
  const canPlay = rec?.status === "processed" || (rec?.durationMs ?? 0) > 0;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <nav className="flex items-center gap-4">
        {pageId ? (
          <Link
            href={`/w/${params.workspaceId}/p/${encodeURIComponent(pageId)}`}
            className="text-xs text-muted-foreground hover:underline"
          >
            {t.common.back}
          </Link>
        ) : null}
        <Link
          href={`/w/${params.workspaceId}/p?panel=recordings`}
          className="text-xs text-muted-foreground hover:underline"
        >
          {t.recordings.detailBack}
        </Link>
      </nav>
      {rec ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="min-w-0 break-words text-xl font-semibold">{title}</h1>
            <ReclassifyContextButton workspaceId={params.workspaceId} primitive="recording" rowId={rec.recordingId} />
          </div>
          <RecordingPlayerProvider
            key={rec.recordingId}
            recordingId={canPlay ? rec.recordingId : null}
            durationMs={rec.durationMs ?? 0}
          >
            <RecordingChromeContent
              recordingId={rec.recordingId}
              workspaceId={params.workspaceId}
              title={title}
              summary={rec}
              standalone
            />
          </RecordingPlayerProvider>
        </>
      ) : recovery ? (
        <section className="space-y-4">
          <h1 className="break-words text-xl font-semibold">{recovery.title}</h1>
          <RecordingProcessAction key={params.recordingId} workspaceId={params.workspaceId} recordingId={params.recordingId} mime={recovery.mime} recovery={recovery} />
        </section>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {error ? t.recordings.detailNotFound : t.recordings.panelLoading}
        </p>
      )}
    </main>
  );
}
