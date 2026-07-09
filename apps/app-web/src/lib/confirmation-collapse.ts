/**
 * Collapse policy for RESOLVED tool-confirmation rows in the chat dock
 * (`[COMP:app-web/confirmation-collapse]`).
 *
 * During a long one-action-at-a-time run (e.g. deleting stale research
 * files one by one) every approved call used to append a permanent
 * "Done. … completed." receipt row, and the pile buried the next
 * actionable Approve/Deny card off-screen. This policy caps the
 * resolved block at TWO rows regardless of how many actions ran:
 *
 * - 1-2 resolved rows → all render individually (no summary noise).
 * - 3+ → everything but the newest collapses into one counts-by-status
 *   summary row ("7 completed · 1 denied"); the newest keeps its full
 *   receipt row. Failures matter most right when they happen — which is
 *   exactly when the failed row IS the newest — and stay tallied in the
 *   summary once superseded.
 *
 * Pure — the dock (`floating-chat.tsx`) renders the result. Spec:
 * docs/architecture/features/doc.md → "One dock, every surface".
 */

export type ResolvedConfirmationCounts = {
  approved: number;
  denied: number;
  failed: number;
};

export type CollapsedConfirmations<T> = {
  /** Counts for the collapsed summary row; null when nothing collapses. */
  counts: ResolvedConfirmationCounts | null;
  /** Rows that still render individually, in original order. */
  tail: readonly T[];
};

/** Collapse threshold — below this every resolved row renders as-is. */
const COLLAPSE_AT = 3;

export function collapseResolvedConfirmations<T extends { status: string }>(
  resolved: readonly T[],
): CollapsedConfirmations<T> {
  if (resolved.length < COLLAPSE_AT) {
    return { counts: null, tail: resolved };
  }
  const counts: ResolvedConfirmationCounts = {
    approved: 0,
    denied: 0,
    failed: 0,
  };
  for (const conf of resolved.slice(0, -1)) {
    if (conf.status === "approved") counts.approved += 1;
    else if (conf.status === "failed") counts.failed += 1;
    else counts.denied += 1;
  }
  return { counts, tail: resolved.slice(-1) };
}
