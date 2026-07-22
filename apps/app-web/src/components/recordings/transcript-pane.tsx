"use client";

/**
 * The transcript, as a readable + seekable list: every line jumps the player to
 * that exact moment, and the line under the playhead highlights and scrolls
 * itself into view as playback runs.
 *
 * Renders on the brief page (in the recording chrome's Transcript tab) and on
 * the standalone detail route. Reads `transcript_segments` via
 * `/api/recordings/:id/transcript`, NOT the transcript file - the segments are
 * the retrieval substrate and the only thing carrying `start_ms`/`speaker`; the
 * file is for reading and download. See recordings.md -> "The transcript
 * artifact".
 *
 * Follow-the-playhead is opt-out (`follow`): a user who has scrolled up to read
 * something is not yanked back by the next segment boundary. Clicking a line
 * re-arms it, because that is an explicit "take me there".
 *
 * [COMP:app-web/recording-chrome]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatStamp } from "@use-brian/shared";
import { useT } from "@/lib/i18n/client";
import { useRecordingPlayer } from "@/lib/recordings/recording-player-context";
import {
  getRecordingTranscript,
  type TranscriptSegment,
} from "@/lib/api/recordings";

export function TranscriptPane({
  recordingId,
  className = "",
  focusMs = null,
  focusNonce = 0,
  fetchPage,
}: {
  recordingId: string;
  className?: string;
  /**
   * Scroll to (and mark) the line covering this moment — a citation asking to
   * be read, rather than the playhead. Null means "just follow playback".
   */
  focusMs?: number | null;
  /** Bumped per request so re-clicking the same citation re-scrolls. */
  focusNonce?: number;
  /**
   * One page of transcript. Defaults to the authed
   * `/api/recordings/:id/transcript` read; the anonymous shared-page surface
   * passes the public source-scoped fetcher — same response shape, so the
   * paging / follow / citation-focus machinery is shared.
   */
  fetchPage?: (fromIndex: number) => Promise<{
    segments: TranscriptSegment[];
    hasMore: boolean;
    toIndex: number;
  }>;
}) {
  const t = useT();
  const { seekTo, currentMs } = useRecordingPlayer();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextFrom, setNextFrom] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef<HTMLLIElement | null>(null);
  const focusedRef = useRef<HTMLLIElement | null>(null);
  // Follow the playhead until the user scrolls away; a click re-arms it.
  const [follow, setFollow] = useState(true);

  const load = useCallback(
    async (from: number) => {
      setLoading(true);
      try {
        const page = fetchPage
          ? await fetchPage(from)
          : await getRecordingTranscript(recordingId, from);
        setSegments((prev) => (from === 0 ? page.segments : [...prev, ...page.segments]));
        setHasMore(page.hasMore);
        setNextFrom(page.toIndex + 1);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [recordingId, fetchPage],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  // Keep the active line visible. `nearest` (not `center`) so a line already on
  // screen does not jitter the pane on every segment boundary.
  useEffect(() => {
    if (!follow || focusMs !== null) return;
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentMs, follow, focusMs]);

  // A citation asked for a specific line. `center` (not `nearest`) because the
  // point is to READ AROUND the claim, so the line wants context above and
  // below it — unlike playback-follow, which only needs the line on screen.
  useEffect(() => {
    if (focusMs === null) return;
    focusedRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusMs, focusNonce, segments.length]);

  // The cited line may sit past the loaded window — the transcript pages, and a
  // 96-minute meeting's `[1:12:04]` is several pages in. Pull the next page
  // until the moment is covered rather than silently failing to scroll. Bounded
  // by `hasMore`, so it stops at the end of the transcript.
  useEffect(() => {
    if (focusMs === null || loading || !hasMore) return;
    const last = segments[segments.length - 1];
    if (last && focusMs > last.end_ms) void load(nextFrom);
  }, [focusMs, focusNonce, loading, hasMore, segments, nextFrom, load]);

  if (error) {
    return (
      <p className="text-sm text-muted-foreground">{t.recordings.detailTranscriptError}</p>
    );
  }
  if (!loading && segments.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.recordings.detailNoTranscript}</p>;
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t.recordings.detailSeekHint}</span>
        {!follow ? (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          >
            {t.recordings.transcriptFollow}
          </button>
        ) : null}
      </div>
      <ol
        className="space-y-1 overflow-y-auto"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
      >
        {segments.map((s) => {
          const active = currentMs >= s.start_ms && currentMs < s.end_ms;
          // The line the citation pointed at. Marked independently of `active`:
          // the playhead may be elsewhere (or the audio may not play at all),
          // and the reader still needs to see WHICH line the claim came from.
          const cited =
            focusMs !== null && focusMs >= s.start_ms && focusMs < s.end_ms;
          return (
            <li
              key={s.segment_index}
              ref={cited ? focusedRef : active ? activeRef : undefined}
            >
              <button
                type="button"
                onClick={() => {
                  seekTo(s.start_ms);
                  setFollow(true);
                }}
                className={`flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-muted/60 ${
                  cited
                    ? "bg-primary/10 ring-1 ring-primary/40"
                    : active
                      ? "bg-muted"
                      : ""
                }`}
              >
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatStamp(s.start_ms)}
                </span>
                <span>
                  {s.speaker ? <b className="mr-1">{s.speaker}:</b> : null}
                  {s.segment_text}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {hasMore ? (
        <button
          type="button"
          onClick={() => void load(nextFrom)}
          disabled={loading}
          className="mt-3 rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
        >
          {t.recordings.detailLoadMore}
        </button>
      ) : null}
    </div>
  );
}
