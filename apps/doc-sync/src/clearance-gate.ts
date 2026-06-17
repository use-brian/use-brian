/**
 * The page-level clearance gate (Lock #5). Runs on WS connect for an
 * authenticated user: one RLS-scoped query resolves the page's workspace +
 * clearance and the viewer's workspace-member clearance, then `canRead`
 * decides. A user who isn't a workspace member, or whose clearance is below
 * the page's, never joins the document.
 *
 * The query fn is injected (queryWithRLS-shaped) so this unit-tests without a
 * DB. `canRead` is the same comparator the rest of the brain uses.
 *
 * OSS single-player stub (oss-local-brain-wedge.md §12.3 #3): the group/grant
 * layer is dropped. The closed multi-user collaboration surface
 * (`workspace_groups`, `workspace_group_members`, `page_grants`) is NOT in the
 * open base schema, so the per-user / per-group role resolution that used to run
 * after the membership query (`GROUP_IDS_SQL`, `IDENTITY_GRANTS_SQL`,
 * `resolveEffectiveRole`) would read tables that don't exist locally. For the
 * single auto-provisioned human connection we short-circuit to an always-grant
 * `role: 'edit'` (the workspace-member baseline). The FIRST query is retained
 * unchanged: the auto-provisioned owner `workspace_members` row satisfies it, so
 * page-not-found / not-a-member and insufficient-clearance still gate correctly.
 * The `/internal/apply` AI-write path stays ungated (unchanged).
 *
 * [COMP:doc-sync/clearance-gate]
 */

import { canRead, type Sensitivity } from '@sidanclaw/core/dist/security/sensitivity.js'

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
         wm.clearance    AS "memberClearance"
  FROM saved_views sv
  JOIN workspace_members wm ON wm.workspace_id = sv.workspace_id
  WHERE sv.id = $1 AND wm.user_id = $2
  LIMIT 1
`

export async function assertPageAccess(params: {
  userId: string
  pageId: string
  query: RlsQuery
}): Promise<PageAccess> {
  const rows = await params.query<{
    workspaceId: string
    pageClearance: Sensitivity | null
    memberClearance: Sensitivity | null
  }>(params.userId, PAGE_ACCESS_SQL, [params.pageId, params.userId])

  const row = rows[0]
  if (!row) throw new PageAccessDenied('not_a_workspace_member')

  const pageClearance: Sensitivity = row.pageClearance ?? 'internal'
  const memberClearance: Sensitivity = row.memberClearance ?? 'internal'
  if (!canRead(memberClearance, pageClearance)) {
    throw new PageAccessDenied('insufficient_clearance')
  }

  // OSS single-player always-grant (oss-local-brain-wedge.md §12.3 #3): the
  // member is the auto-provisioned owner, so the role is the workspace-member
  // baseline `edit`. The group/grant reads + resolveEffectiveRole are dropped
  // (their tables back the closed multi-user surface, absent from the open
  // schema). Multi-user role differentiation lives in the closed repo.
  return { workspaceId: row.workspaceId, clearance: pageClearance, role: 'edit' }
}
