/**
 * Doc v1 — single-step undo bridge.
 *
 * Phase 1 plumbing for Lock #9 (undo bumped to v1). Bridges the
 * `patchPage` write path and the `saved_views.last_undo JSONB` column
 * added in migration 200 so the user's Cmd-Z fires a clean revert via
 * `applyOps` over a previously-captured inverse-ops list.
 *
 * Three pure functions, no DB, no I/O:
 *
 *   - `buildUndoEntry`     — produces the JSONB payload `patchPage` should
 *                            persist after a successful forward apply. Wraps
 *                            `invertOps` and stamps version + timestamp.
 *   - `applyUndoEntry`     — given a current page + version + entry, returns
 *                            the reverted page and the next version number.
 *                            Throws on version mismatch so the caller can
 *                            re-fetch and surface a clean error.
 *   - `isUndoEntryStale`   — TTL check for the (post-v1) GC sweep. Not
 *                            load-bearing for v1; provided so the worker
 *                            doesn't have to reinvent the comparison.
 *
 * The DB-side persistence (writing this payload to `saved_views.last_undo`)
 * is the SavedViewStore implementation's responsibility — Agent P1C in
 * Batch 2 owns wiring it onto the existing store interface. This module
 * just defines the shape and the apply logic.
 *
 * Spec refs:
 *   - `docs/plans/snuggly-noodling-tiger.md` Lock #9 ("undo bumped to v1")
 *   - `docs/plans/doc-v1-execution.md` §6.7 (Phase 2 deep-dive)
 *   - `packages/api/migrations/200_doc_v1.sql` (`last_undo JSONB`)
 *
 * [COMP:doc/undo]
 */

import type { Ops, Page } from './page-types.js'
import { applyOps, invertOps } from './ops.js'

// ── Wire-format ──────────────────────────────────────────────────────

/**
 * What gets stored in `saved_views.last_undo`. Single-step undo only —
 * applying a new forward patch overwrites this row, dropping any older
 * undo history on the floor.
 *
 *   - `appliedAt`         — ISO-8601 timestamp the forward patch landed.
 *                           Used by `isUndoEntryStale` for the GC sweep.
 *   - `resultingVersion`  — the page version *after* the forward patch
 *                           ran. `applyUndoEntry` refuses to operate on a
 *                           page whose current version differs from this,
 *                           which is how we detect "the page changed since
 *                           you last edited" without optimistic locking.
 *   - `inverseOps`        — the inverse-ops list produced by `invertOps`
 *                           against the pre-state page. Applied verbatim
 *                           to revert.
 *   - `idMap`             — the `tmp-*` → real id map captured from the
 *                           forward patch's `applyOps` return. Persisted
 *                           alongside the inverse so a post-restart undo
 *                           still references the right ids (the forward
 *                           tmp ids are gone by then, but inverse already
 *                           used real ids — the field exists for audit /
 *                           future redo support).
 */
export type UndoEntry = {
  appliedAt: string
  resultingVersion: number
  inverseOps: Ops
  idMap?: Record<string, string>
}

// ── buildUndoEntry ───────────────────────────────────────────────────

/**
 * Constructs an `UndoEntry` from a forward patch's inputs and outputs.
 * Called by `patchPage` immediately after a successful `applyOps` /
 * commit so the resulting payload can be written to `saved_views.last_undo`
 * in the same transaction.
 *
 *   - `prePage`           — page state *before* the forward patch ran.
 *                           Needed by `invertOps` to capture prior values
 *                           for `edit` / `delete` / `move` / `setTitle`
 *                           inverses.
 *   - `forwardOps`        — the ops list the user submitted.
 *   - `idMap`             — the `tmp-*` → real id map returned by the
 *                           forward `applyOps` call. Required for the
 *                           inverse `delete` ops to reference the real
 *                           ids users see post-commit.
 *   - `resultingVersion`  — the page version after the forward patch
 *                           committed (i.e. `preVersion + 1`).
 */
export function buildUndoEntry(
  prePage: Page,
  forwardOps: Ops,
  idMap: Record<string, string>,
  resultingVersion: number,
): UndoEntry {
  const inverseOps = invertOps(prePage, forwardOps, { idMap })
  return {
    appliedAt: new Date().toISOString(),
    resultingVersion,
    inverseOps,
    idMap,
  }
}

// ── applyUndoEntry ───────────────────────────────────────────────────

/**
 * Applies a previously-stored `UndoEntry` to the current page state.
 * Used by the undo chat tool / Cmd-Z handler.
 *
 * Returns the reverted page + the next version number (current + 1).
 * The caller is responsible for:
 *   1. Persisting the reverted page at the new version.
 *   2. Clearing `saved_views.last_undo` for this row (undo is single-step
 *      — once applied, the entry must not be reusable, otherwise a second
 *      Cmd-Z would re-revert and surprise the user).
 *
 * Throws if `currentVersion !== entry.resultingVersion`. The caller
 * should treat that as "this page changed since you last edited", refresh
 * its local state, and surface a clean message to the user. Don't silently
 * swallow — replaying an undo against a page that drifted produces garbage.
 */
export function applyUndoEntry(
  currentPage: Page,
  currentVersion: number,
  entry: UndoEntry,
): { page: Page; nextVersion: number } {
  if (currentVersion !== entry.resultingVersion) {
    throw new Error(
      `undo conflict: expected page version ${entry.resultingVersion}, got ${currentVersion}. Refetch and try again.`,
    )
  }
  const { page } = applyOps(currentPage, entry.inverseOps)
  return { page, nextVersion: currentVersion + 1 }
}

// ── isUndoEntryStale ─────────────────────────────────────────────────

/**
 * TTL check for the (post-v1) GC sweep. Undo entries older than the
 * given age threshold can be safely cleared — a user returning to a page
 * a week later shouldn't be able to undo a patch they no longer remember.
 *
 * Not load-bearing for v1; the doc-v1 master plan defers undo GC to
 * Phase 5. The helper lives here so the future worker doesn't have to
 * re-derive the comparison.
 */
export function isUndoEntryStale(
  entry: UndoEntry,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): boolean {
  const age = Date.now() - new Date(entry.appliedAt).getTime()
  return age > maxAgeMs
}
