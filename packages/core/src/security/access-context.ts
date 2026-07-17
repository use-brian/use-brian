import type { Sensitivity } from './sensitivity.js'

/**
 * Viewer context required to project a resource into per-viewer access
 * (P1-12 universal projection — see
 * `docs/architecture/platform/sensitivity.md` → "Universal access predicate").
 *
 * `userId` and `assistantId` are nullable on the row but always set on the
 * viewer — a `NULL` on the row means "scope wider than this viewer
 * dimension" and is always visible.
 *
 * `assistantKind` reflects the calling assistant's `assistants.kind`
 * column (`'primary' | 'standard' | 'app'`). The DB-layer predicate
 * treats `'primary'` as the workspace reflector: the `assistant_id`
 * partition is dropped so the primary sees every assistant's rows in
 * its workspace. Confidentiality is still bounded by `clearance` (and
 * primary defaults to `'confidential'` — the highest tier — so
 * downcleared workspaces stay isolated). See
 * `docs/architecture/platform/sensitivity.md` → "Primary widens".
 *
 * `clearance` is the viewer's max readable sensitivity tier. It is
 * **optional**: system callers (consolidation workers, commitment-lifecycle
 * worker, knowledge sync — see `permissions.md` § Privileged-service
 * exception) have no per-viewer sensitivity ceiling. When omitted, the
 * DB-layer predicate drops the `sensitivity_rank` clause and projects only
 * the workspace + visibility-double axes.
 *
 * `compartments` is the viewer's *effective* compartment grant — the
 * non-hierarchical MLS category axis (see `docs/plans/compartment-axis.md`).
 * **Optional**: `undefined`/`null` is the universe grant (cleared into every
 * compartment) and the DB-layer predicate drops the compartment clause. A
 * finite array restricts reads to rows whose compartment set is a subset of
 * the grant (`row.compartments <@ $grant`); an empty array (`[]`) is a viewer
 * cleared into nothing, matching only uncompartmented rows. For a workspace
 * turn the effective grant is `member ∩ assistant`
 * (`resolveReadCompartmentsSystem`). Not yet populated at entry points — the
 * read-gate machinery ships inert until wiring lands.
 *
 * The runtime predicate helper lives in `packages/api/src/db/access-predicate.ts`
 * (`buildAccessPredicate(ctx, opts)`). This file owns just the type so it
 * can flow through `@use-brian/core` store interfaces without dragging in
 * the API package.
 */
export type AccessContext = {
  workspaceId: string
  userId: string
  assistantId: string
  assistantKind: AssistantKind
  clearance?: Sensitivity
  compartments?: string[] | null
  /**
   * Bypass the member RLS policy and rely **solely** on the
   * `buildAccessPredicate` WHERE-clause for gating. Only for trusted
   * non-member reads where `userId` is not a workspace member and would
   * otherwise be hidden by RLS — specifically the anonymous public-share
   * render path, whose principal is synthetic. Store reads honour this by
   * running the bare `query()` (system_bypass-enabled) instead of
   * `queryWithRLS(userId, …)`.
   *
   * SAFETY: only ever set together with a pinned `clearance` (e.g.
   * `'public'`). `systemRead: true` with `clearance: undefined` would
   * expose every sensitivity tier — the predicate's clearance clause is
   * the containment. `buildPublicAccessContext` is the only producer.
   */
  systemRead?: boolean
}

export type AssistantKind = 'primary' | 'standard' | 'app'
