"use client";

/**
 * The live transcript surface — a purpose-built pane for a meeting that is
 * (or was just) streaming to this page, replacing the old raw-text-blocks
 * transcript that fought the doc editor's typography and could be edited or
 * deleted out from under the stream.
 *
 * Data: `live_transcript_windows` via `GET /api/recordings/live/windows`
 * (poll while mounted — teammates watching the page converge within one
 * interval), plus the same-tab CustomEvent bridge for instant append when
 * THIS tab is the one recording. Lines carry best-effort per-window
 * "Speaker N" labels; real names bind later on the final transcript.
 *
 * Mounted by the doc shell when the page carries the `live:` marker block
 * and the final (processed) transcript has not replaced it yet.
 *
 * [COMP:app-web/live-transcript-pane]
 */

import { useEffect, useRef, useState } from "react";
import { formatStamp } from "@use-brian/shared";
import { useT } from "@/lib/i18n/client";
import {
  listLiveTranscriptWindows,
  type LiveTranscriptWindowRow,
} from "@/lib/api/recordings";
import {
  LIVE_TRANSCRIPT_WINDOW_EVENT,
  type LiveTranscriptWindowDetail,
} from "@/lib/recordings/live-transcript-events";

const POLL_MS = 10_000;

/** Merge-by-chunkId, capture order — poll results and event appends converge. */
export function mergeLiveWindows(
  current: LiveTranscriptWindowRow[],
  incoming: LiveTranscriptWindowRow[],
): LiveTranscriptWindowRow[] {
  const byId = new Map(current.map((w) => [w.chunkId, w] as const));
  for (const w of incoming) byId.set(w.chunkId, w);
  return [...byId.values()].sort((a, b) => a.offsetMs - b.offsetMs);
}

export function LiveTranscriptPane({
  workspaceId,
  pageId,
}: {
  workspaceId: string;
  pageId: string;
}) {
  const t = useT();
  const [windows, setWindows] = useState<LiveTranscriptWindowRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToEndRef = useRef(true);

  // Initial fetch + poll. Windows stop arriving once the capture ends, at
  // which point the poll is cheap 304-ish reads until the surface unmounts
  // (the doc shell swaps in the final transcript when processing completes).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await listLiveTranscriptWindows(workspaceId, pageId);
        if (!cancelled) {
          setWindows((prev) => mergeLiveWindows(prev, rows));
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId, pageId]);

  // Same-tab instant append from the recorder's stream.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LiveTranscriptWindowDetail>).detail;
      if (!detail || detail.pageId !== pageId) return;
      setWindows((prev) =>
        mergeLiveWindows(prev, [
          {
            chunkId: detail.chunkId,
            offsetMs: detail.offsetMs,
            durationMs: detail.durationMs,
            missedBefore: detail.missedBefore,
            lines: detail.lines,
          },
        ]),
      );
    };
    window.addEventListener(LIVE_TRANSCRIPT_WINDOW_EVENT, handler);
    return () => window.removeEventListener(LIVE_TRANSCRIPT_WINDOW_EVENT, handler);
  }, [pageId]);

  // Follow the tail while the reader is at the tail; never yank a reader who
  // scrolled up (the transcript-pane lesson).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToEndRef.current) el.scrollTop = el.scrollHeight;
  }, [windows.length]);

  if (loaded && windows.length === 0) return null;

  return (
    <section className="mb-6 rounded-lg border border-border bg-muted/20 p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left text-sm font-medium hover:text-foreground/80"
      >
        <span
          aria-hidden
          className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        {t.recordings.liveTranscriptTitle}
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          {t.recordings.liveTranscriptProvisional}
        </span>
      </button>
      {expanded ? (
        <div
          ref={scrollRef}
          onWheel={() => {
            const el = scrollRef.current;
            if (!el) return;
            pinnedToEndRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="mt-2 max-h-80 overflow-y-auto rounded-md border border-border bg-background px-3 py-2"
        >
          {!loaded ? (
            <p className="text-sm text-muted-foreground">{t.recordings.liveTranscriptLoading}</p>
          ) : (
            <ol className="space-y-1">
              {windows.map((w) => (
                <li key={w.chunkId}>
                  {w.missedBefore > 0 ? (
                    <p className="px-2 py-0.5 text-xs italic text-muted-foreground">
                      {t.recordings.liveTranscriptGap.replace(
                        "{count}",
                        String(w.missedBefore),
                      )}
                    </p>
                  ) : null}
                  {w.lines.map((line, i) => (
                    <p key={`${w.chunkId}-${i}`} className="flex gap-3 px-2 py-0.5 text-sm">
                      {i === 0 ? (
                        <span className="shrink-0 tabular-nums text-xs leading-5 text-muted-foreground">
                          {formatStamp(w.offsetMs)}
                        </span>
                      ) : (
                        <span className="w-[3.75rem] shrink-0" aria-hidden />
                      )}
                      <span>
                        {line.speaker ? <b className="mr-1">{line.speaker}:</b> : null}
                        {line.text}
                      </span>
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
