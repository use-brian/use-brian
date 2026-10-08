"use client";

/**
 * Recordings panel — the workspace's recordings board, rendered as a
 * **doc-shell panel tab** (`/w/[workspaceId]/p?panel=recordings`), NOT its own
 * top-level route. The doc tab strip, sidebar, and chat dock persist around it.
 *
 * Panel vs route, and why this feature has BOTH: a panel is a BOARD — a list
 * you scan, with no identity of its own. A single recording is an artifact
 * other pages link INTO by id, and that a brief's `[H:MM:SS]` citation
 * deep-links to with `#t=<seconds>`; it keeps its route
 * (`/w/<wid>/recordings/<id>`). Rows here navigate there. The same split the
 * doc surface already makes between the tree and a page.
 *
 * Every recording gets a home here whether or not it has a brief: synthesis is
 * opt-in on `blueprintSlug`, so a recording uploaded with no blueprint has no
 * page at all — before this it was reachable only through the brain's search
 * results or a transcript file in the files UI.
 *
 * Pure logic (grouping, labels, the openable rule) lives in
 * `lib/recordings/recordings-board.ts` — app-web's vitest is node-only, so the
 * component stays thin over it and shares its component tag, the same shape as
 * `[COMP:web/blueprints-library]`.
 *
 * Spec: docs/architecture/media/recordings.md → "The board (panel) vs the
 * detail (route)".
 * [COMP:app-web/recordings-board]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { listRecordings, type RecordingSummary } from "@/lib/api/recordings";
import { useCachedResource } from "@/lib/surface-cache";
import { recordingsCacheKey } from "@/lib/surface-prefetch";
import { Skeleton } from "@/components/skeleton";
import {
  formatBytes,
  formatDuration,
  groupByDay,
  hasInFlight,
  isOpenable,
  matchesStatusFilter,
  recordingTitle,
  statusFilterToQuery,
  STATUS_FILTERS,
  type DayBucket,
  type StatusFilter,
} from "@/lib/recordings/recordings-board";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

/** Re-poll while anything is still transcribing. */
const POLL_MS = 10_000;

/** How many rows the board pulls. The route caps it server-side regardless. */
const PAGE_SIZE = 50;

function StatusChip({ rec }: { rec: RecordingSummary }) {
  const t = useT();
  if (rec.status === "processed") {
    return rec.truncated ? (
      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
        {t.recordings.panelTruncated}
      </span>
    ) : null;
  }
  const label =
    rec.status === "failed"
      ? t.recordings.panelFailed
      : rec.status === "awaiting_upload"
        ? t.recordings.panelAwaitingUpload
        : t.recordings.panelProcessing;
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${
        rec.status === "failed"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}

function Row({ rec, workspaceId }: { rec: RecordingSummary; workspaceId: string }) {
  const t = useT();
  const title = recordingTitle(rec, t.recordings.panelUntitled);
  const meta = [formatDuration(rec.durationMs), formatBytes(rec.bytes)]
    .filter(Boolean)
    .join(" · ");

  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <StatusChip rec={rec} />
      {meta ? (
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{meta}</span>
      ) : null}
    </>
  );

  // Not openable yet ⇒ render the row, but not as a link. The detail page is a
  // player + a transcript, and both are empty until processing finishes;
  // sending someone there would look like a broken page rather than a pending one.
  if (!isOpenable(rec)) {
    return (
      <li
        className="flex items-center gap-3 rounded px-2 py-2 text-sm opacity-60"
        aria-disabled="true"
      >
        {body}
      </li>
    );
  }
  return (
    <li>
      <Link
        href={`/w/${workspaceId}/recordings/${rec.recordingId}`}
        className="flex items-center gap-3 rounded px-2 py-2 text-sm hover:bg-muted/60"
      >
        {body}
      </Link>
    </li>
  );
}

export function RecordingsPanel() {
  const t = useT();
  const { activeId: workspaceId } = useWorkspaces();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  // One cache slot per (status filter, search needle) (N1): a re-open paints
  // the last-known board on the first frame and revalidates behind it; the
  // old `setLoading(true)` on every mount is what used to blank it. No spine
  // primitive covers recordings today, so liveness stays the in-flight poll
  // below - now a `refresh()` on this key instead of a private row copy.
  const board = useLeasedResource<RecordingSummary[]>(
    workspaceId ? recordingsCacheKey(workspaceId, status, query) : null,
    () =>
      listRecordings(workspaceId ?? "", {
        ...(statusFilterToQuery(status) ? { status: statusFilterToQuery(status)! } : {}),
        ...(query.trim() ? { q: query.trim() } : {}),
        limit: PAGE_SIZE,
      }),
  );
  const recordings = board.data;
  const loading = board.loading;
  // A cold failure (nothing cached) is the error line; a failed revalidation
  // keeps the last good rows on screen (the cache's keep-last-good rule).
  const error = board.data === undefined && board.error !== undefined;

  // A recording is transcribed by a background worker, so a row that is queued
  // when the board opens becomes openable with no user action. Poll while any
  // row is moving; stop as soon as none is, so an idle board is not a heartbeat.
  // The ref keeps the timer's decision out of the effect's dependency list so
  // a re-render (or a key change) never restarts it.
  const latest = useRef(board);
  latest.current = board;
  useEffect(() => {
    const timer = setInterval(() => {
      const current = latest.current;
      if (current.data && hasInFlight(current.data)) void current.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(() => {
    const visible = (recordings ?? []).filter((r) => matchesStatusFilter(r, status));
    return groupByDay(visible, new Date());
  }, [recordings, status]);

  const bucketLabel: Record<DayBucket, string> = {
    today: t.recordings.panelToday,
    yesterday: t.recordings.panelYesterday,
    earlier: t.recordings.panelEarlier,
  };

  const statusLabel: Record<StatusFilter, string> = {
    all: t.recordings.panelFilterAll,
    processed: t.recordings.panelFilterProcessed,
    processing: t.recordings.panelFilterProcessing,
    failed: t.recordings.panelFilterFailed,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">{t.recordings.panelTitle}</h1>
        <div className="flex-1" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.recordings.panelSearchPlaceholder}
          aria-label={t.recordings.panelSearchPlaceholder}
          className="h-8 w-48 rounded-md border border-border bg-transparent px-2 text-[16px] md:text-sm"
        />
        {/* Themed SearchableSelect, never the browser-native element. */}
        <SearchableSelect
          value={status}
          onValueChange={(v) => setStatus((v || "all") as StatusFilter)}
          items={STATUS_FILTERS.map((s) => ({ value: s, label: statusLabel[s] }))}
          aria-label={t.recordings.panelFilterLabel}
          className="w-40"
          popupClassName="w-40"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <p className="text-sm text-muted-foreground">{t.recordings.panelError}</p>
        ) : loading ? (
          // Cold cache only (N4): the row recipe's geometry, never a sentence.
          <div className="flex flex-col gap-1" aria-busy>
            <Skeleton className="mb-1 h-3 w-16" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3 rounded px-2 py-2">
                <Skeleton className="h-3.5" style={{ width: `${40 + ((i * 23) % 45)}%` }} />
                <Skeleton className="ml-auto h-3 w-16 shrink-0" />
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {query.trim() || status !== "all"
              ? t.recordings.panelNoMatches
              : t.recordings.panelEmpty}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.bucket} className="mb-4">
              <h2 className="mb-1 text-xs font-medium text-muted-foreground">
                {bucketLabel[group.bucket]}
              </h2>
              <ul>
                {group.recordings.map((rec) => (
                  <Row key={rec.recordingId} rec={rec} workspaceId={workspaceId ?? ""} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
