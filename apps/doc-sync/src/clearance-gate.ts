/**
 * The page-level clearance gate (Lock #5) + the per-page write-authz role
 * resolver. Runs on WS connect for an authenticated user:
 *
 *  1. One RLS-scoped query resolves the page's workspace + clearance and the
 *     viewer's workspace-member clearance, then `canRead` decides. A user who
 *     isn't a workspace member, or whose clearance is below the page's, never
 *     joins the document. This is the confidentiality gate.
 *  2. A second RLS-scoped query resolves the viewer's **effective grant role**
 *     from `page_grants` by the §13 D1 model — most-specific principal wins
 *     (`user` > `group` > `workspace`-default), falling back to the workspace
 *     member baseline `edit` when the page carries no grant for the viewer.
 *     `view`/`comment` roles join the live doc READ-ONLY (`index.ts` sets
 *     Hocuspocus `connectionConfig.readOnly` from this), so a member downgraded
 *     below `edit` on a readable page can no longer mutate the CRDT. Clearance
 *     (step 1) independently gates page-open, so a grant never escalates a
 *     member above their clearance and a downgrade never re-opens a page they
 *     couldn't read. This is the write-authorization completeness pass.
 *
 * The query fn is injected (queryWithRLS-shaped) so this unit-tests without a
 * DB. `canRead` is the same comparator the rest of the brain uses; the grant
 * precedence mirrors `page-grant-store.ts`'s role vocabulary.
 *
 * The `/internal/apply` AI-write path stays ungated (it opens a direct
 * service connection that never runs `onAuthenticate`).
 *
 * [COMP:doc-sync/clearance-gate]
 */

import { canRead, type Sensitivity } from '@use-brian/core/dist/security/sensitivity.js'

export class PageAccessDenied extends Error {
  constructor(public readonly reason: string) {
    super(`doc page access denied: ${reason}`)
    this.name = 'PageAccessDenied'
  }
}

/** queryWithRLS-shaped: scopes rows to the acting user via RLS. */
export type RlsQuery = <T>(userId: string, sql: string, params: unknown[]) => Promise<T[]>

export type GrantRole = 'view' | 'comment' | 'edit' | 'full'

export type PageAccess = { workspaceId: string; clearance: Sensitivity; role: GrantRole }

export const PAGE_ACCESS_SQL = `
  SELECT sv.workspace_id AS "workspaceId",
         sv.clearance    AS "pageClearance",
         wm.clearance    AS "memberClearance",
         ts.sensitivity  AS "teamspaceSensitivity"
  FROM saved_views sv
  JOIN workspace_members wm ON wm.workspace_id = sv.workspace_id
  LEFT JOIN teamspaces ts ON ts.id = sv.teamspace_id
  WHERE sv.id = $1 AND wm.user_id = $2
  LIMIT 1
`

/**
 * The viewer's most-specific live grant role on the page, or NULL when none
 * applies (→ the caller uses the `edit` baseline). Priority: a `user` grant
 * for the viewer wins over a `group` grant (via `workspace_group_members`)
 * wins over the `workspace`-default grant. `link`/`published` principals are
 * excluded — those are the anonymous external surface, never an authenticated
 * member's role. `revoked_at IS NULL` + unexpired only. RLS
 * (`page_grants_workspace_member`) already confines rows to the viewer's
 * workspace; the `principal_ref` predicates confine to the viewer's identity.
 */
export const PAGE_ROLE_SQL = `
  SELECT pg.role AS role
  FROM page_grants pg
  WHERE pg.page_id = $1
    AND pg.revoked_at IS NULL
    AND (pg.expires_at IS NULL OR pg.expires_at > now())
    AND (
      (pg.principal_type = 'user'      AND pg.principal_ref = $2)
      OR (pg.principal_type = 'group'  AND pg.principal_ref IN (
            SELECT gm.group_id::text FROM workspace_group_members gm WHERE gm.user_id = $2::uuid))
      OR (pg.principal_type = 'workspace')
    )
  ORDER BY CASE pg.principal_type
             WHEN 'user' THEN 0
             WHEN 'group' THEN 1
             WHEN 'workspace' THEN 2
             ELSE 3
           END
  LIMIT 1
`

/** The workspace-member baseline when a readable page carries no grant. */
const BASELINE_ROLE: GrantRole = 'edit'

const VALID_ROLES: ReadonlySet<string> = new Set<GrantRole>(['view', 'comment', 'edit', 'full'])

export async function assertPageAccess(params: {
  userId: string
  pageId: string
  query: RlsQuery
}): Promise<PageAccess> {
  const rows = await params.query<{
    workspaceId: string
    pageClearance: Sensitivity | null
    memberClearance: Sensitivity | null
    teamspaceSensitivity: Sensitivity | null
  }>(params.userId, PAGE_ACCESS_SQL, [params.pageId, params.userId])

  const row = rows[0]
  // The RLS-scoped read already carries the teamspace HARD boundary
  // (migration 313): a page in a teamspace the viewer doesn't belong to —
  // or another creator's private page — returns no row, same as a
  // non-member. Membership in the workspace alone no longer implies the
  // row is visible.
  if (!row) throw new PageAccessDenied('not_a_workspace_member')

  const pageClearance: Sensitivity = row.pageClearance ?? 'internal'
  const memberClearance: Sensitivity = row.memberClearance ?? 'internal'
  if (!canRead(memberClearance, pageClearance)) {
    throw new PageAccessDenied('insufficient_clearance')
  }
  // The teamspace's sensitivity tier layers on top of the per-page
  // clearance (teamspaces.md): a member filed into a container whose tier
  // later rose above their clearance (demotion edge) never joins the doc.
  // NULL = a private page (creator-only via RLS) — no container tier.
  if (row.teamspaceSensitivity && !canRead(memberClearance, row.teamspaceSensitivity)) {
    throw new PageAccessDenied('insufficient_teamspace_clearance')
  }

  const role = await resolveEffectiveRole(params)
  return { workspaceId: row.workspaceId, clearance: pageClearance, role }
}

/**
 * Resolve the viewer's effective write-authz role after the clearance gate has
 * passed. Returns the most-specific live grant role, or the `edit` baseline
 * when the page has no grant for the viewer (a bare workspace member on an
 * ungranted page keeps the historical read-write default). A malformed role
 * value from the row (should be impossible under the CHECK constraint) is
 * treated as the fail-safe `view` — never silently upgraded to `edit`.
 */
export async function resolveEffectiveRole(params: {
  userId: string
  pageId: string
  query: RlsQuery
}): Promise<GrantRole> {
  const rows = await params.query<{ role: string | null }>(
    params.userId,
    PAGE_ROLE_SQL,
    [params.pageId, params.userId],
  )
  const raw = rows[0]?.role
  if (raw == null) return BASELINE_ROLE
  return VALID_ROLES.has(raw) ? (raw as GrantRole) : 'view'
}

/** Non-`edit`/`full` roles join the live doc read-only (CRDT write-filter). */
export function isReadOnlyRole(role: GrantRole): boolean {
  return role !== 'edit' && role !== 'full'
}
