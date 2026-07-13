/**
 * Pure filtering helpers for the unified approval queue (app-web).
 *
 * Ported from `apps/web/src/lib/approvals-filter.ts` (app consolidation
 * §5a). Split out of the React surface so the kind/assistant/age filter and
 * the "which kinds resolve in-place" rule are plain, testable functions.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals
 * ("Approval queue UI … filterable by kind / assistant / age").
 */

import type { ApprovalKind, PendingApprovalRow } from "@/lib/api/approvals";

/**
 * Kinds the unified queue resolves in place. The unified
 * `POST /api/approvals/:id/respond` resolves `workflow_step` (always),
 * `tool_invocation` (`resumeDeps` wired), and `staged_write` (the staged
 * tool executes server-side on approve; a 502 keeps the row pending for
 * retry). The staged_skill_* kinds resolve in place too, but through the
 * DEDICATED `/api/skills/approvals` endpoints — `respondByKind`
 * (lib/api/approvals.ts) routes each row. Only `distribution_draft`
 * (feed) and `question` (chat) still defer to their originating surface
 * via the `nativeSurface` hint.
 */
export const ACTIONABLE_KINDS: readonly ApprovalKind[] = [
  "workflow_step",
  "tool_invocation",
  "staged_write",
  "staged_skill_creation",
  "staged_skill_update",
  // Logic-block terminal sends (computer-use R2-5): the block's runner
  // polls the row, so responding in place IS the resume.
  "browser_skill_send",
];

export function isActionable(kind: ApprovalKind): boolean {
  return ACTIONABLE_KINDS.includes(kind);
}

/** Cumulative recency buckets for the age filter. */
export type AgeFilter = "all" | "24h" | "7d" | "older";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a row's pending age falls within the selected (cumulative) bucket. */
export function matchesAge(
  createdAtIso: string,
  age: AgeFilter,
  now: number,
): boolean {
  if (age === "all") return true;
  const elapsed = now - new Date(createdAtIso).getTime();
  if (age === "24h") return elapsed < DAY_MS;
  if (age === "7d") return elapsed < 7 * DAY_MS;
  return elapsed >= 7 * DAY_MS;
}

export type ApprovalFilter = {
  kind: ApprovalKind | "all";
  assistant: string | "all";
  age: AgeFilter;
};

export const NO_FILTER: ApprovalFilter = {
  kind: "all",
  assistant: "all",
  age: "all",
};

export function isFilterActive(filter: ApprovalFilter): boolean {
  return (
    filter.kind !== "all" || filter.assistant !== "all" || filter.age !== "all"
  );
}

/** Apply the kind/assistant/age filter to the queue. */
export function filterApprovals(
  rows: readonly PendingApprovalRow[],
  filter: ApprovalFilter,
  now: number,
): PendingApprovalRow[] {
  return rows.filter((r) => {
    if (filter.kind !== "all" && r.kind !== filter.kind) return false;
    if (
      filter.assistant !== "all" &&
      r.originatingAssistantId !== filter.assistant
    ) {
      return false;
    }
    return matchesAge(r.createdAt, filter.age, now);
  });
}

/** Distinct kinds present in the queue, in first-seen order. */
export function presentKinds(
  rows: readonly PendingApprovalRow[],
): ApprovalKind[] {
  const seen = new Set<ApprovalKind>();
  for (const r of rows) seen.add(r.kind);
  return [...seen];
}

/** Distinct originating assistant ids present in the queue, in first-seen order. */
export function presentAssistantIds(
  rows: readonly PendingApprovalRow[],
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.originatingAssistantId) seen.add(r.originatingAssistantId);
  }
  return [...seen];
}
