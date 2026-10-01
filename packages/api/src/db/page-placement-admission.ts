import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Sensitivity, SavedViewStore, Page } from '@use-brian/core'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type PagePlacement = {
  teamspaceId?: string | null
  projectId?: string | null
  nestParentId?: string | null
  clearance?: Sensitivity
}

/** Select under normal RLS, then re-read under the fixed metadata lock.
 * The lock is not authorization; all page-operation checks remain below. */
async function lockPlacementMetadata(client: PoolClient, workspaceId: string, teamspaceId: string | null, defaultDepartmentId: string | null) {
  const candidate = (await client.query<{ id: string }>(`SELECT t.id
      FROM teamspaces t JOIN workspace_groups g ON g.id=t.workspace_group_id AND g.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1 AND g.kind='team' AND g.status='active'
        AND (($2::uuid IS NOT NULL AND t.id=$2) OR ($2::uuid IS NULL AND t.is_default AND g.id=$3))
      `, [workspaceId, teamspaceId, defaultDepartmentId])).rows[0]
  if (!candidate) return undefined
  const locked = (await client.query<{ id: string; departmentId: string; compartment: string; sensitivity: Sensitivity; isDefault: boolean }>(
    `SELECT id,department_id AS "departmentId",compartment,sensitivity,is_default AS "isDefault"
     FROM lock_page_placement_teamspace($1,$2)`, [workspaceId, candidate.id])).rows[0]
  // The row can have changed while waiting for its lock. Revalidate default
  // intent rather than admitting the pre-lock metadata snapshot.
  if (!teamspaceId && (!locked?.isDefault || locked.departmentId !== defaultDepartmentId)) return undefined
  return locked
}

// Deliberately narrower than pageSchema: that schema strips unknown keys and
// allows live bindings, child pages, extraction slots and media. Root mutation
// permission is NOT authority to read held/retracted embedded resources.
// No child adapter is admitted yet, so reject all references (held or not),
// including rich text/Markdown links and unknown nested metadata. Plain text
// copied under the page's own boundary is not proof of external source lineage.
const copyPlainText = z.string().max(8192).regex(/^[\p{L}\p{N}\p{Zs}\n\r\t.,!?\u0027\u0022“”‘’…—–-]*$/u)
const copyBlockId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const plainCopyPage = z.object({ blocks: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), id: copyBlockId, text: copyPlainText,
    variant: z.enum(['body', 'muted', 'caption']).optional() }).strict(),
  z.object({ kind: z.literal('heading'), id: copyBlockId, text: copyPlainText,
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).strict(),
  z.object({ kind: z.literal('divider'), id: copyBlockId }).strict(),
])).max(10000) }).strict()

export type LockedPageCopySource = { id: string; page: Page; version: number; name: string }

/** Authored placement or canonical same-placement page copy. A source handle is
 * only a lookup: current source permissions and metadata are checked below. */
export async function withPagePlacement<T>(
  workspaceId: string, userId: string, input: PagePlacement,
  write: (client: PoolClient, placement: PagePlacement, source?: LockedPageCopySource) => Promise<T>,
  options?: Parameters<SavedViewStore['createDraft']>[1],
  copySource?: { pageId: string; version: number },
): Promise<T> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    // First row lock, before policy, parent, or destination reads.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const policy = await readAdmissionPolicy(client, workspaceId)
    const placement = { ...input }
    let source: LockedPageCopySource | undefined
    if (copySource) {
      if (policy?.setupState !== 'ready') throw new WorkspaceAccessError('access_mode_setup_required', 409)
      // UPDATE lock also excludes a concurrent first documents INSERT via its
      // page FK; existing live snapshots are locked separately below. No owner
      // fallback, grant widening, or body-supplied source envelope is allowed.
      const row = (await client.query<LockedPageCopySource & { teamspaceId: string | null; projectId: string | null; clearance: Sensitivity; anchorKey: string | null; linkedRecordingId: string | null; parentPageId: string | null }>(
        `SELECT id,page,version,name,teamspace_id AS "teamspaceId",project_id AS "projectId",clearance,
          anchor_key AS "anchorKey",linked_recording_id AS "linkedRecordingId",parent_page_id AS "parentPageId"
         FROM saved_views WHERE id=$1 AND workspace_id=$2
           AND saved_view_root_operation_scope_allows(id,true) FOR UPDATE`, [copySource.pageId, workspaceId])).rows[0]
      if (!row) throw new WorkspaceAccessError('context_not_available', 404)
      // Recordings/workflow anchors need their own current source/hold adapter.
      // saved_views itself has no canonical scope-held kind.
      if (row.anchorKey || row.linkedRecordingId || row.parentPageId) throw new WorkspaceAccessError('page_source_admission_required', 409)
      if (input.nestParentId || (input.teamspaceId !== undefined && input.teamspaceId !== row.teamspaceId)
        || (input.projectId !== undefined && input.projectId !== row.projectId)) {
        throw new WorkspaceAccessError('page_copy_destination_floor_conflict', 409)
      }
      const live = (await client.query<{ page: Page | null; version: number; name: string | null }>(
        `SELECT snapshot_json AS page,seq::int AS version,snapshot_title AS name
         FROM documents WHERE page_id=$1 FOR UPDATE`, [row.id])).rows[0]
      source = { id: row.id, page: live?.page ?? row.page ?? { blocks: [] }, version: live?.version ?? row.version,
        name: live?.name ?? row.name }
      if (source.version !== copySource.version) throw new WorkspaceAccessError('page_copy_source_changed', 409)
      // Check the actual locked live snapshot, not the stale saved_views.page
      // or the request body. Fail closed rather than stripping hidden sources.
      const plain = plainCopyPage.safeParse(source.page)
      if (!plain.success || !copyPlainText.safeParse(source.name).success) {
        throw new WorkspaceAccessError('page_copy_embedded_source_admission_required', 409)
      }
      source.page = plain.data
      placement.teamspaceId = row.teamspaceId
      placement.projectId = row.projectId
      const ranks = { public: 0, internal: 1, confidential: 2 }
      if (ranks[row.clearance] > ranks[placement.clearance ?? 'internal']) placement.clearance = row.clearance
    }
    if (policy?.setupState === 'ready') {
      if (!source && (options?.provenance.kind !== 'human-authored' || options.provenance.actorId !== userId)) {
        // Source-derived callers need their own current source-floor adapter.
        throw new WorkspaceAccessError('page_source_admission_required', 409)
      }
      const ranks = { public: 0, internal: 1, confidential: 2 }
      let inherited = !!source
      if (input.nestParentId) {
        const parent = (await client.query<{ teamspaceId: string | null; projectId: string | null; clearance: Sensitivity }>(
          `SELECT teamspace_id AS "teamspaceId", project_id AS "projectId", clearance
           FROM saved_views WHERE id=$1 AND workspace_id=$2
             AND saved_view_root_operation_scope_allows(id,true) FOR SHARE`,
          [input.nestParentId, workspaceId],
        )).rows[0]
        if (!parent) throw new WorkspaceAccessError('context_not_available', 404)
        if ((input.teamspaceId !== undefined && input.teamspaceId !== parent.teamspaceId)
          || (input.projectId !== undefined && input.projectId !== parent.projectId)) {
          throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
        }
        placement.teamspaceId = parent.teamspaceId
        placement.projectId = parent.projectId
        if (ranks[parent.clearance] > ranks[placement.clearance ?? 'internal']) placement.clearance = parent.clearance
        inherited = true
      }
      if (placement.teamspaceId === undefined) {
        if (policy.mode !== 'simple') throw new WorkspaceAccessError('context_selection_required', 409)
        const linked = await lockPlacementMetadata(client, workspaceId, null, policy.defaultDepartmentId)
        // Provisioning is an access change, never a writer-side repair.
        if (!linked) throw new WorkspaceAccessError('page_linked_default_teamspace_provisioning_required', 409)
        placement.teamspaceId = linked.id
      }
      const team = placement.teamspaceId ? await lockPlacementMetadata(client, workspaceId, placement.teamspaceId, null) : undefined
      if (placement.teamspaceId && (!team?.departmentId || !team.compartment)) throw new WorkspaceAccessError('context_selection_required', 409)
      // Destination metadata remains locked even for mutations that do not
      // take the workspace barrier.
      if (placement.projectId) {
        const project = await client.query("SELECT id FROM workspace_projects WHERE id=$1 AND workspace_id=$2 AND status='active'", [placement.projectId, workspaceId])
        if (!project.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
      }
      let sensitivity = placement.clearance ?? 'internal'
      if (team && ranks[team.sensitivity] > ranks[sensitivity]) sensitivity = team.sensitivity
      const envelope = { visibility: placement.teamspaceId ? 'workspace' as const : 'private' as const,
        sensitivity, compartments: team?.compartment ? [team.compartment] : [], projectIds: placement.projectId ? [placement.projectId] : [] }
      await admitWorkspaceResource(client, workspaceId, userId, {
        visibility: envelope.visibility, sensitivity,
        ...(inherited ? { inherited: envelope } : team ? { destination: { kind: 'department' as const, departmentId: team.departmentId! } } : {}),
        requestedLabels: { projectIds: envelope.projectIds },
      })
      const allowed = (await client.query<{ ok: boolean }>(`SELECT
        saved_view_principal_boundary_allows($1,$2,$3,$4,$5)
        AND saved_view_operation_scope_allows($1,$4,$3,$5,true) AS ok`,
      [workspaceId, userId, placement.teamspaceId, sensitivity, placement.projectId ?? null])).rows[0]
      if (!allowed?.ok) throw new WorkspaceAccessError('context_not_available', 404)
      placement.clearance = sensitivity
    }
    const result = await write(client, placement, source)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await rollbackAndRelease(client)
  }
}
