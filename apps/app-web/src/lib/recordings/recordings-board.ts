/**
 * Pure logic behind the recordings panel — the board's grouping, labels, and
 * the "is this row openable" rule.
 *
 * Extracted from the component because app-web's vitest is node-only (no
 * component-render harness), the same pattern as `lib/blueprints.ts` and
 * `lib/skills-view.ts`: the panel stays thin over these.
 *
 * [COMP:app-web/recordings-board]
 */

import type { RecordingStatus, RecordingSummary } from "@/lib/api/recordings";

/**
 * A recording is openable once there is something to open: the detail page is a
 * player plus a transcript, and both are empty until it has been processed.
 * Routing a user to an empty player and calling it a bug report is worse than
 * showing them the row is still working.
 */
export function isOpenable(rec: Pick<RecordingSummary, "status">): boolean {
  return rec.status === "processed";
}

/** A row is still moving — the board polls while any row is in flight. */
export function isInFlight(rec: Pick<RecordingSummary, "status">): boolean {
  return rec.status === "queued" || rec.status === "processing";
}

/** True when the board should keep polling: something is still being worked on. */
export function hasInFlight(recs: ReadonlyArray<Pick<RecordingSummary, "status">>): boolean {
  return recs.some(isInFlight);
}

/**
 * `durationMs` → `H:MM:SS` / `M:SS`, the row's duration chip.
 *
 * Deliberately NOT `formatStamp` from `@sidanclaw/shared`: that renders a
 * CITATION (always `H:MM:SS`, so `[0:47:21]` parses back), and a 90-second memo
 * showing "0:01:30" in a list reads as a bug. Same numbers, different job —
 * a citation must round-trip, a duration must read naturally.
 */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Bytes → a short human size for the row's meta line. */
export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/** The row's display title, degrading through what the row actually has. */
export function recordingTitle(rec: RecordingSummary, fallback: string): string {
  return rec.title?.trim() || rec.fileName?.trim() || fallback;
}

/** Date-bucket key for the board's grouping, resolved against a reference day. */
export type DayBucket = "today" | "yesterday" | "earlier";

/**
 * Bucket a recording by day. `now` is injected rather than read from the clock
 * so this is testable and so the caller owns the timezone question — bucketing
 * is done in the VIEWER's local day, which is what "today" means to them.
 */
export function dayBucket(occurredAt: string, now: Date): DayBucket {
  const then = new Date(occurredAt);
  if (Number.isNaN(then.getTime())) return "earlier";
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return "earlier";
}

export type RecordingGroup = { bucket: DayBucket; recordings: RecordingSummary[] };

/**
 * Group the (already newest-first) list into day buckets, preserving order and
 * dropping empty buckets. The server sorts; this only partitions — re-sorting
 * here would be a second opinion about ordering that could disagree with the
 * cursor the list route pages on.
 */
export function groupByDay(recs: RecordingSummary[], now: Date): RecordingGroup[] {
  const order: DayBucket[] = ["today", "yesterday", "earlier"];
  const byBucket = new Map<DayBucket, RecordingSummary[]>();
  for (const rec of recs) {
    const bucket = dayBucket(rec.occurredAt, now);
    const list = byBucket.get(bucket);
    if (list) list.push(rec);
    else byBucket.set(bucket, [rec]);
  }
  return order
    .filter((b) => byBucket.has(b))
    .map((bucket) => ({ bucket, recordings: byBucket.get(bucket)! }));
}

/** The status filter's options — `all` plus the states worth filtering to. */
export const STATUS_FILTERS = ["all", "processed", "processing", "failed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Map a filter choice to the list query's `status`.
 *
 * "In progress" means `queued` OR `processing` — that split is ours, not the
 * user's (a queued job simply has not been picked up yet), so the filter must
 * cover both. The list route takes a single `status`, so this sends none and
 * `matchesStatusFilter` narrows client-side.
 *
 * The honest caveat: client-side narrowing happens AFTER the server's limit, so
 * "In progress" only surfaces in-flight rows within the newest page. That is
 * sound rather than merely tolerable — an in-flight recording was uploaded
 * minutes ago and the list is newest-first, so it is on the first page by
 * construction. If the route ever takes a status LIST, send both and delete the
 * client arm.
 */
export function statusFilterToQuery(filter: StatusFilter): RecordingStatus | undefined {
  if (filter === "all") return undefined;
  if (filter === "processing") return undefined; // widened client-side; see above
  return filter;
}

/** Client-side arm of the status filter (the `processing` widening). */
export function matchesStatusFilter(
  rec: Pick<RecordingSummary, "status">,
  filter: StatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "processing") return isInFlight(rec);
  return rec.status === filter;
}
