/**
 * The single Office access predicate. Every REST, WebSocket, worker, listing,
 * notification, offline, export and release path resolves through this seam.
 * See docs/architecture/features/office.md → Access.
 *
 * [COMP:api/office-access]
 */
import { queryWithRLS } from '../db/client.js'

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

  const mutable = projection.lifecycleState === 'active'
  return {
    artifactId: projection.artifactId,
    workspaceId: projection.workspaceId,
    role,
    workspaceRole: projection.memberRole,
    lifecycleState: projection.lifecycleState,
    canView: true,
    canComment: mutable && (role === 'comment' || role === 'edit'),
    canEdit: mutable && role === 'edit',
    canRestore: (projection.lifecycleState === 'archived' || projection.lifecycleState === 'trash' || projection.lifecycleState === 'retained') && (role === 'edit' || projection.memberRole === 'owner' || projection.memberRole === 'admin'),
    canDeletePermanently: (projection.ownerUserId === userId || projection.memberRole === 'owner' || projection.memberRole === 'admin') && (projection.lifecycleState === 'trash' || projection.lifecycleState === 'retained'),
    canElevate: mutable && (projection.memberRole === 'owner' || projection.memberRole === 'admin') && role !== 'edit',
  }
}

export const OFFICE_ACCESS_SQL = `
  SELECT a.id                         AS "artifactId",
         a.workspace_id               AS "workspaceId",
         a.creator_user_id            AS "creatorUserId",
         a.owner_user_id              AS "ownerUserId",
         a.sensitivity                AS sensitivity,
         a.visibility_user_ids        AS "visibilityUserIds",
         a.required_compartments      AS "requiredCompartments",
         COALESCE(src.eligible, TRUE) AS "sourcesEligible",
         a.default_workspace_role     AS "defaultWorkspaceRole",
         a.lifecycle_state            AS "lifecycleState",
         wm.role                      AS "memberRole",
         wm.clearance                 AS "memberClearance",
         wm.compartments              AS "memberCompartments",
         g.role                       AS "explicitRole",
         g.revoked_at                 AS "grantRevokedAt"
    FROM office_artifacts a
    JOIN workspace_members wm
      ON wm.workspace_id = a.workspace_id AND wm.user_id = $2
    LEFT JOIN office_artifact_grants g
      ON g.artifact_id = a.id AND g.user_id = $2
    LEFT JOIN LATERAL (
      SELECT bool_and(
        CASE s.sensitivity WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 ELSE 3 END
          <= CASE wm.clearance WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END
        AND (cardinality(s.visibility_user_ids)=0 OR $2=ANY(s.visibility_user_ids))
        AND (wm.compartments IS NULL OR s.required_compartments <@ wm.compartments)
      ) AS eligible
      FROM office_artifact_sources s
      WHERE s.artifact_id=a.id AND s.retracted_at IS NULL
    ) src ON TRUE
   WHERE a.id = $1
   LIMIT 1
`

export async function resolveOfficeAccess(
  userId: string,
  artifactId: string,
): Promise<ResolvedOfficeAccess | null> {
  const result = await queryWithRLS<OfficeAccessProjection>(userId, OFFICE_ACCESS_SQL, [artifactId, userId])
  const row = result.rows[0]
  return row ? resolveOfficeAccessProjection(userId, row) : null
}
