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
 * decision is shared with persisted Page mutation policies.
 *
 * The `/internal/apply` path rechecks the same current mutation authority;
 * service authentication alone does not grant a Page edit.
 *
 * [COMP:doc-sync/clearance-gate]
 */

import { canRead, type Sensitivity } from '@use-brian/core/dist/security/sensitivity.js'
import { parseSyncDocumentName } from './document-router.js'

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

type PageConnectionContext = {
  service?: true
  userId?: string
  sessionId?: string
  authVersion?: number
  workspaceId?: string
  role?: GrantRole
}

export type PageRoomConnection = {
  context?: PageConnectionContext
  readOnly: boolean
  sendStateless(message: string): void
  close(event?: { code: number; reason: string }): void
}

export type PageRoomDocument = { getConnections(): PageRoomConnection[] }

export type PageAuthorityDeps = {
  query: RlsQuery
  validateSession(claims: { userId: string; sessionId?: string; authVersion?: number }): Promise<boolean>
}

export type PageConnectionAuthority = 'read-write' | 'read-only' | 'denied' | 'service'

export const PAGE_ACCESS_SQL = `
  SELECT sv.workspace_id AS "workspaceId",
         sv.clearance    AS "pageClearance",
         wm.clearance    AS "memberClearance",
         ts.sensitivity  AS "teamspaceSensitivity",
         saved_view_operation_scope_allows(
           sv.workspace_id, sv.clearance, sv.teamspace_id, sv.project_id, true, sv.shared_project_id
         ) AS "canMutate"
  FROM saved_views sv
  JOIN workspace_members wm ON wm.workspace_id = sv.workspace_id
  LEFT JOIN teamspaces ts ON ts.id = sv.teamspace_id
  WHERE sv.id = $1 AND wm.user_id = $2
  LIMIT 1
`

/** Canonical actor-bound role. The database returns explicit `edit` for an
 * admitted page with no applicable grant, and NULL for unavailable pages. */
export const PAGE_ROLE_SQL = `
  SELECT public.saved_view_effective_role($1::uuid) AS role
`

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
    canMutate: boolean
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
  return {
    workspaceId: row.workspaceId,
    clearance: pageClearance,
    role: row.canMutate ? role : 'view',
  }
}

/** Resolve the canonical current role after the independent read gate.
 * NULL/absent/malformed is unavailable and fails closed to `view`; only the
 * database may return the no-grant `edit` baseline after current admission. */
export async function resolveEffectiveRole(params: {
  userId: string
  pageId: string
  query: RlsQuery
}): Promise<GrantRole> {
  const rows = await params.query<{ role: string | null }>(
    params.userId,
    PAGE_ROLE_SQL,
    [params.pageId],
  )
  const raw = rows[0]?.role
  if (raw == null) return 'view'
  return VALID_ROLES.has(raw) ? (raw as GrantRole) : 'view'
}

/** Non-`edit`/`full` roles join the live doc read-only (CRDT write-filter). */
export function isReadOnlyRole(role: GrantRole): boolean {
  return role !== 'edit' && role !== 'full'
}

/** Bind a trusted internal apply to the same current Edit floor as a human
 * socket. The shared secret authenticates the API service, never the page
 * mutation itself. */
export async function assertPageMutationAccess(params: {
  userId: string
  pageId: string
  query: RlsQuery
}): Promise<PageAccess> {
  const access = await assertPageAccess(params)
  if (isReadOnlyRole(access.role)) throw new PageAccessDenied('write_denied')
  return access
}

/** Refresh a live connection before accepting a message, failing closed. */
export async function recheckPageConnection(params: {
  userId?: string
  pageId: string
  query: RlsQuery
  connection: { readOnly: boolean; sendStateless: (message: string) => void }
}): Promise<void> {
  const { connection } = params
  const wasReadOnly = connection.readOnly
  connection.readOnly = true
  try {
    if (!params.userId) throw new PageAccessDenied('missing_user')
    const access = await assertPageAccess({ ...params, userId: params.userId })
    connection.readOnly = isReadOnlyRole(access.role)
    if (wasReadOnly !== connection.readOnly) connection.sendStateless(connection.readOnly ? 'page-write-denied' : 'page-write-allowed')
  } catch (error) {
    connection.sendStateless('page-write-denied')
    throw error
  }
}

function denyPageConnection(connection: PageRoomConnection): PageConnectionAuthority {
  connection.readOnly = true
  connection.sendStateless('page-access-denied')
  connection.close({ code: 4403, reason: 'Page access denied' })
  return 'denied'
}

/** Re-resolve one current room recipient. Resolver/session failure denies and
 * closes only that connection; another peer's failure never blocks an
 * authorized recipient from being audited. Direct internal connections are
 * already bound at their HTTP endpoint and do not represent a socket peer. */
async function revalidatePageConnection(params: {
  pageId: string
  connection: PageRoomConnection
  deps: PageAuthorityDeps
}): Promise<PageConnectionAuthority> {
  const { connection } = params
  const context = connection.context
  if (context?.service) return 'service'
  if (!context?.userId) return denyPageConnection(connection)
  try {
    if (!await params.deps.validateSession({
      userId: context.userId,
      sessionId: context.sessionId,
      authVersion: context.authVersion,
    })) return denyPageConnection(connection)
    const access = await assertPageAccess({ userId: context.userId, pageId: params.pageId, query: params.deps.query })
    const wasReadOnly = connection.readOnly
    connection.readOnly = isReadOnlyRole(access.role)
    context.workspaceId = access.workspaceId
    context.role = access.role
    if (wasReadOnly !== connection.readOnly) {
      connection.sendStateless(connection.readOnly ? 'page-write-denied' : 'page-write-allowed')
    }
    return connection.readOnly ? 'read-only' : 'read-write'
  } catch {
    return denyPageConnection(connection)
  }
}

/** Audit every human recipient before a protected room broadcast. */
export async function revalidatePageRoom(params: {
  pageId: string
  document: PageRoomDocument
  deps: PageAuthorityDeps
}): Promise<Map<PageRoomConnection, PageConnectionAuthority>> {
  const connections = params.document.getConnections()
  const results = await Promise.all(connections.map(async connection => [
    connection,
    await revalidatePageConnection({ ...params, connection }),
  ] as const))
  return new Map(results)
}

/** Close passive revoked peers even while their page room is otherwise idle. */
export async function sweepPageRooms(params: {
  documents: ReadonlyMap<string, PageRoomDocument>
  deps: PageAuthorityDeps
}): Promise<number> {
  let audited = 0
  for (const [name, document] of params.documents) {
    let target
    try { target = parseSyncDocumentName(name) } catch { continue }
    if (target.kind !== 'page') continue
    audited += document.getConnections().length
    await revalidatePageRoom({ pageId: target.id, document, deps: params.deps })
  }
  return audited
}
