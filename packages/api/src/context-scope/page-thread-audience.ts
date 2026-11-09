/** Principal proof for Page evidence delivered back to that Page's thread.
 * Labels remain the caller/destination validator's independent responsibility.
 * [COMP:api/page-thread-audience]
 */
import type { ScopeSource } from '@use-brian/core'
import { getPool } from '../db/client.js'
import { sessionKindSql } from '../session-kind.js'

export type PageThreadAudience = { sessionId: string; actorUserId: string }
type Boundary = {
  pageId: string; workspaceId: string; principalBoundary: string;
  creatorId: string; teamspaceId: string | null; departmentId: string | null;
  unavailable: boolean;
}
type PageAuthority = { source: ScopeSource | null; requiredSources: ScopeSource[]; principalAllowed: boolean }

/** Exact Page identity and saved/current principal boundaries are mandatory.
 * The original actor proves source access. No anonymous UUID or replacement
 * member is sent to the Page reader, and labels never stand in for Page access.
 */
export async function readPageThreadAudienceAuthority(workspaceId: string, source: Pick<ScopeSource, 'resourceKind' | 'resourceId'>,
  destination: PageThreadAudience): Promise<PageAuthority | null> {
  const row = (await getPool().query<{
    authority: PageAuthority | null; target: Boundary;
    boundaries: Record<string, Boundary>; observation: Boundary | null;
  }>(`SELECT read_page_scope_authority($1,$2,$3,$5) AS authority,
      workflow_page_event_boundary(p) AS target,r.boundaries,o.boundary AS observation
    FROM sessions s JOIN comment_threads ct ON ct.session_id=s.id AND ct.workspace_id=s.workspace_id
    JOIN saved_views p ON p.id=ct.page_id AND p.workspace_id=s.workspace_id
    LEFT JOIN workflow_page_event_observations o ON o.workspace_id=$1 AND o.id=$3
      AND $2 IN('page_live_changed','page_live_destination')
    JOIN workflow_page_event_receipts r ON r.workspace_id=$1 AND r.page_id=p.id
      AND r.revision=CASE WHEN $2 IN('page_live_changed','page_live_destination') THEN o.receipt_id ELSE $3 END
    WHERE s.workspace_id=$1 AND s.id=$4 AND ${sessionKindSql.pageThread('s')} AND ${sessionKindSql.workspaceAudience('s')}
    FOR SHARE OF s,ct,p,r`, [workspaceId,source.resourceKind,source.resourceId,destination.sessionId,destination.actorUserId])).rows[0]
  if (!row || !row.authority?.principalAllowed || !row.authority.source || row.target.unavailable !== false) return null
  const samePrincipal = (boundary: Boundary) => boundary.unavailable === false
    && boundary.pageId === row.target.pageId && boundary.workspaceId === workspaceId
    && boundary.principalBoundary === row.target.principalBoundary
    && (boundary.principalBoundary === 'private' ? boundary.creatorId === row.target.creatorId
      : boundary.principalBoundary === 'department' ? boundary.departmentId === row.target.departmentId
        : boundary.principalBoundary === 'teamspace' && boundary.teamspaceId === row.target.teamspaceId)
  if (!Object.values(row.boundaries).every(samePrincipal) || row.observation && !samePrincipal(row.observation)) return null
  return row.authority
}
