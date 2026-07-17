/**
 * Universal access projection (P1-12) — see
 * docs/architecture/platform/sensitivity.md → "Universal access predicate"
 * and "Universal resource projection". (A fifth, non-hierarchical
 * "compartment" axis is proposed in docs/plans/compartment-axis.md.)
 *
 * Composes the four projection axes — workspace partition, visibility user,
 * visibility assistant, sensitivity clearance — into a single AND-group
 * suitable for embedding in any store's WHERE clause.
 *
 * WU-4.1 shipped this helper; WU-4.2a applied it to `retrieval-store.ts`;
 * WU-4.2b extended `AccessContext.clearance` to optional and rolled the
 * predicate out across every other `packages/api/src/db/*` read path.
 * The no-clearance branch projects only workspace + visibility-double
 * (system-caller path; see `permissions.md` § Privileged-service exception).
 *
 * Bi-temporal filtering (`valid_to IS NULL`) and retraction filtering are
 * intentionally orthogonal — the caller composes them alongside this
 * predicate when needed.
 *
 * `sensitivity_rank()` (migration 065) is the existing PG ordering helper
 * reused here.
 */

import type { AccessContext } from '@use-brian/core'

/**
 * `AccessContext` is defined in `@use-brian/core` so it can flow through
 * store interfaces (`MemoryStore`, `EntityStore`, etc.) without the core
 * package taking a dependency on `@use-brian/api`. We re-export it here
 * for ergonomic imports inside the API package.
 */
export type { AccessContext }

export type AccessPredicateOptions = {
  /** Column prefix for JOINed queries, e.g. `'m'` → `m.workspace_id`. Default: no prefix. */
  alias?: string
  /** First `$N` placeholder index. Default: 1. */
  startIdx?: number
}

export type AccessPredicate = {
  /** SQL fragment, joinable as a single AND-group. Wrap in parens if combining with OR. */
  sql: string
  /**
   * Params in placeholder order. Length varies with the viewer shape and which
   * optional axes are present:
   *
   * - `kind='primary'` (workspace reflector) drops the `assistant_id` partition,
   *   so `assistantId` is NOT in the list: `[workspaceId, userId]`.
   * - `kind='standard' | 'app'`: `[workspaceId, userId, assistantId]`.
   * - `+ clearance` (a `Sensitivity` string) when `ctx.clearance` is set.
   * - `+ compartments` (a `string[]` for the `<@ $n::text[]` clause) when
   *   `ctx.compartments` is a finite grant (omitted for the universe grant).
   *
   * Callers spread this straight into their values array, so the order — not a
   * precise tuple type — is what matters.
   */
  params: Array<string | string[]>
  /** First `$N` index available *after* this fragment — caller's next param goes here. */
  nextIdx: number
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Build the universal access projection (P1-12) as an SQL fragment + ordered
 * params + the next-available placeholder index.
 *
 * The fragment is a single AND-group (no leading `AND`, no trailing
 * whitespace), so a caller can embed it as the first condition after `WHERE`
 * or join it with further conditions via `AND`.
 *
 *     const ap = buildAccessPredicate(ctx, { alias: 'm', startIdx: 1 })
 *     const sql = `SELECT ... FROM memories m
 *                  WHERE ${ap.sql}
 *                    AND m.valid_to IS NULL`
 *     const values = [...ap.params, ...]  // next param uses ap.nextIdx
 */
export function buildAccessPredicate(
  ctx: AccessContext,
  options?: AccessPredicateOptions,
): AccessPredicate {
  const startIdx = options?.startIdx ?? 1
  const alias = options?.alias
  if (alias !== undefined && !IDENTIFIER_RE.test(alias)) {
    throw new Error(
      `buildAccessPredicate: invalid alias ${JSON.stringify(alias)} — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    )
  }
  const p = alias ? `${alias}.` : ''
  const i = startIdx
  // Transitional NULL tolerance on workspace_id: WU-4.1 spec wants
  // `workspace_id = $W` (strict), but the current schema still allows
  // `workspace_id IS NULL` on personal-scope rows (see migration 110's
  // `workspace_scope_consistency` CHECK). Until a follow-up migration
  // backfills + enforces NOT NULL, NULL acts like "global" and is
  // gated by the visibility-double instead. Strict-match becomes
  // safe once the schema is tightened — drop the IS NULL branch then.
  //
  // Primary widen: `kind='primary'` is the workspace reflector — the
  // assistant_id partition is dropped so the primary sees every
  // assistant's rows in its workspace. The `user_id` partition still
  // applies (user-specific rows stay scoped to the viewing user), and
  // the clearance ceiling still applies (downcleared primary stays
  // bounded). See `docs/architecture/platform/sensitivity.md`
  // → "Primary widens".
  const isPrimary = ctx.assistantKind === 'primary'
  const visibilityClauses = isPrimary
    ? `(${p}workspace_id IS NULL OR ${p}workspace_id = $${i})` +
      ` AND (${p}user_id IS NULL OR ${p}user_id = $${i + 1})`
    : `(${p}workspace_id IS NULL OR ${p}workspace_id = $${i})` +
      ` AND (${p}user_id IS NULL OR ${p}user_id = $${i + 1})` +
      ` AND (${p}assistant_id IS NULL OR ${p}assistant_id = $${i + 2})`
  const baseNextIdx = isPrimary ? i + 2 : i + 3

  // Build the optional trailing axes incrementally. Each is omitted when its
  // `ctx` field is absent, so the fragment stays byte-identical to the
  // visibility-only / +clearance forms for every existing caller.
  let sql = visibilityClauses
  const params: Array<string | string[]> = isPrimary
    ? [ctx.workspaceId, ctx.userId]
    : [ctx.workspaceId, ctx.userId, ctx.assistantId]
  let nextIdx = baseNextIdx

  // Sensitivity ladder (optional — system callers omit it; see header).
  if (ctx.clearance !== undefined) {
    sql += ` AND sensitivity_rank(${p}sensitivity) <= sensitivity_rank($${nextIdx})`
    params.push(ctx.clearance)
    nextIdx += 1
  }

  // Compartment axis (optional — null/undefined = universe grant ⇒ clause
  // dropped). Superset rule: a row is visible iff its compartment set is a
  // subset of the viewer's effective grant (`row.compartments <@ $grant`). An
  // empty grant (`[]`) matches only uncompartmented (`'{}'`) rows. See
  // docs/plans/compartment-axis.md.
  if (ctx.compartments !== undefined && ctx.compartments !== null) {
    sql += ` AND ${p}compartments <@ $${nextIdx}::text[]`
    params.push(ctx.compartments)
    nextIdx += 1
  }

  return { sql, params, nextIdx }
}
