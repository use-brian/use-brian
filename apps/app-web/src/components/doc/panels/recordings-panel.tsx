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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { listRecordings, type RecordingSummary } from "@/lib/api/recordings";
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
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Poll only while something is in flight; the ref keeps the timer's decision
  // out of the effect's dependency list so a re-render never restarts it.
  const inFlight = useRef(false);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!workspaceId) return;
      if (!opts.silent) setLoading(true);
      try {
        const rows = await listRecordings(workspaceId, {
          ...(statusFilterToQuery(status) ? { status: statusFilterToQuery(status)! } : {}),
          ...(query.trim() ? { q: query.trim() } : {}),
          limit: PAGE_SIZE,
        });
        setRecordings(rows);
        setError(false);
        inFlight.current = hasInFlight(rows);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, status, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A recording is transcribed by a background worker, so a row that is queued
  // when the board opens becomes openable with no user action. Poll while any
  // row is moving; stop as soon as none is, so an idle board is not a heartbeat.
  useEffect(() => {
    const timer = setInterval(() => {
      if (inFlight.current) void load({ silent: true });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const groups = useMemo(() => {
    const visible = recordings.filter((r) => matchesStatusFilter(r, status));
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
          className="h-8 w-48 rounded-md border border-border bg-transparent px-2 text-sm"
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
          <p className="text-sm text-muted-foreground">{t.recordings.panelLoading}</p>
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
