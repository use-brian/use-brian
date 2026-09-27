/**
 * The single Office access predicate. Every REST, WebSocket, worker, listing,
 * notification, offline, export and release path resolves through this seam.
 * See docs/architecture/features/office.md → Access.
 *
 * [COMP:api/office-access]
 */
import { defaultOfficeDbQuery } from '../db/office-artifacts.js'

export type OfficeRole = 'view' | 'comment' | 'edit'
export type OfficeLifecycleState = 'active' | 'archived' | 'trash' | 'retained' | 'purged'
export type WorkspaceRole = 'owner' | 'admin' | 'member'
export type OfficeClearance = 'public' | 'internal' | 'confidential'

export type OfficeAccessProjection = {
  artifactId: string
  workspaceId: string
  creatorUserId: string
  ownerUserId: string
  sensitivity: OfficeClearance
  visibilityUserIds: string[]
  requiredCompartments: string[]
  sourcesEligible: boolean
  mutationScopeEligible: boolean
  defaultWorkspaceRole: OfficeRole
  lifecycleState: OfficeLifecycleState
  memberRole: WorkspaceRole
  memberClearance: OfficeClearance
  memberCompartments: string[] | null
  explicitRole: OfficeRole | 'deny' | null
  grantRevokedAt: Date | null
}

export type ResolvedOfficeAccess = {
  artifactId: string
  workspaceId: string
  role: OfficeRole
  workspaceRole: WorkspaceRole
  lifecycleState: OfficeLifecycleState
  canView: true
  canComment: boolean
  canEdit: boolean
  canRestore: boolean
  canDeletePermanently: boolean
  canElevate: boolean
  canManageSharing: boolean
}

const CLEARANCE_RANK: Record<OfficeClearance, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
}

export function resolveOfficeAccessProjection(
  userId: string,
  projection: OfficeAccessProjection,
): ResolvedOfficeAccess | null {
  if (projection.lifecycleState === 'purged') return null
  if (CLEARANCE_RANK[projection.memberClearance] < CLEARANCE_RANK[projection.sensitivity]) return null
  if (!projection.sourcesEligible) return null
  if (projection.visibilityUserIds.length > 0 && !projection.visibilityUserIds.includes(userId)) return null
  if (
    projection.memberCompartments !== null &&
    projection.requiredCompartments.some((required) => !projection.memberCompartments!.includes(required))
  ) return null
  if (projection.explicitRole === 'deny' && projection.grantRevokedAt === null) return null
  if (projection.lifecycleState === 'retained' && projection.memberRole === 'member') return null

  let role: OfficeRole
  if (projection.explicitRole && projection.explicitRole !== 'deny' && projection.grantRevokedAt === null) {
    role = projection.explicitRole
  } else if (projection.creatorUserId === userId || projection.ownerUserId === userId) {
    role = 'edit'
  } else {
    role = projection.defaultWorkspaceRole
  }

  const mutationAllowed = projection.mutationScopeEligible === true
  const mutable = mutationAllowed && projection.lifecycleState === 'active'
  return {
    artifactId: projection.artifactId,
    workspaceId: projection.workspaceId,
    role: mutationAllowed ? role : 'view',
    workspaceRole: projection.memberRole,
    lifecycleState: projection.lifecycleState,
    canView: true,
    canComment: mutable && (role === 'comment' || role === 'edit'),
    canEdit: mutable && role === 'edit',
    canRestore: mutationAllowed && (projection.lifecycleState === 'archived' || projection.lifecycleState === 'trash' || projection.lifecycleState === 'retained') && (role === 'edit' || projection.memberRole === 'owner' || projection.memberRole === 'admin'),
    canDeletePermanently: mutationAllowed && (projection.ownerUserId === userId || projection.memberRole === 'owner' || projection.memberRole === 'admin') && (projection.lifecycleState === 'trash' || projection.lifecycleState === 'retained'),
    canElevate: mutable && (projection.memberRole === 'owner' || projection.memberRole === 'admin') && role !== 'edit',
    canManageSharing: mutable && (projection.memberRole === 'owner' || projection.memberRole === 'admin'),
  }
}

export const OFFICE_ACCESS_SQL = `
  SELECT a.id                         AS "artifactId",
         a.workspace_id               AS "workspaceId",
         a.creator_user_id            AS "creatorUserId",
         a.owner_user_id              AS "ownerUserId",
         a.sensitivity                AS sensitivity,
         a.visibility_user_ids        AS "visibilityUserIds",
         a.compartments               AS "requiredCompartments",
         public.office_sources_scope_allows(a.id,a.workspace_id,false) AS "sourcesEligible",
         public.office_artifact_scope_allows(a.id,a.workspace_id,true) AS "mutationScopeEligible",
         a.default_workspace_role     AS "defaultWorkspaceRole",
         a.lifecycle_state            AS "lifecycleState",
         wm.role                      AS "memberRole",
         CASE WHEN wm.role IN ('owner','admin') THEN 'confidential' ELSE wm.clearance END AS "memberClearance",
         public.effective_member_read_compartments(wm.user_id, wm.workspace_id)
                                      AS "memberCompartments",
         g.role                       AS "explicitRole",
         g.revoked_at                 AS "grantRevokedAt"
    FROM office_artifacts a
    JOIN workspace_members wm
      ON wm.workspace_id = a.workspace_id AND wm.user_id = $2
    LEFT JOIN office_artifact_grants g
      ON g.artifact_id = a.id AND g.user_id = $2
   WHERE a.id = $1
   LIMIT 1
`

export async function resolveOfficeAccess(
  userId: string,
  artifactId: string,
): Promise<ResolvedOfficeAccess | null> {
  const result = await defaultOfficeDbQuery<OfficeAccessProjection>(userId, OFFICE_ACCESS_SQL, [artifactId, userId])
  const row = result.rows[0]
  return row ? resolveOfficeAccessProjection(userId, row) : null
}
