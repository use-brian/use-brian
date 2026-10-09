/** Explicit template selection for an uninitialized generation draft.
 * [COMP:api/office-generation-recovery] */
import { canRead, scopeGrantContains, OfficeGenerationTemplateSelection, type OfficeTemplateChoice } from '@use-brian/core'
import { getAppPool, applyRLSGucs, rollbackAndRelease } from '../db/client.js'
import { defaultOfficeDbQuery, type OfficeDbQuery } from '../db/office-artifacts.js'
import { createOfficeGenerationStore, type OfficeGenerationJobRow } from '../db/office-generation.js'
import { OFFICE_ACCESS_SQL, resolveOfficeAccessProjection, type OfficeAccessProjection } from './access.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

type Scope = { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
type Ceiling = { clearance?: Scope['sensitivity']; compartmentGrant?: string[] | null; projectGrant?: string[] | null }
type TemplateRow = OfficeTemplateChoice & { scopes: Scope[] }
type Root = { workspaceId: string; family: string; mode: string; headVersion: number }
const conflict = () => new WorkspaceAccessError('office_generation_recovery_conflict', 409)

function within(scope: Scope, ceiling: Ceiling) {
  return (!ceiling.clearance || canRead(ceiling.clearance, scope.sensitivity))
    && scopeGrantContains(ceiling.compartmentGrant, scope.compartments)
    && scopeGrantContains(ceiling.projectGrant, scope.projectIds)
}

async function read(userId: string, artifactId: string, jobId: string, query: OfficeDbQuery) {
  const root = (await query<Root>(userId, `SELECT workspace_id AS "workspaceId", family, mode,
    head_version::int AS "headVersion" FROM office_artifacts WHERE id=$1`, [artifactId])).rows[0]
  const projection = (await query<OfficeAccessProjection>(userId, OFFICE_ACCESS_SQL, [artifactId,userId])).rows[0]
  const job = await createOfficeGenerationStore(query).get(userId,jobId)
  if (!root || !projection || !job || job.artifactId !== artifactId || job.workspaceId !== root.workspaceId)
    throw new WorkspaceAccessError('context_not_available',404)
  const access = resolveOfficeAccessProjection(userId,projection)
  return { root, job, editable: Boolean(access?.canEdit && job.initiatedByUserId === userId) }
}

async function choices(userId: string, root: Root, job: OfficeGenerationJobRow, query: OfficeDbQuery, ceiling: Ceiling = {}) {
  const authority = job.authorityProjection as Partial<Scope> & Ceiling | null
  if (!authority?.sensitivity) return []
  const pinned: Ceiling = {clearance:authority.clearance ?? authority.sensitivity,
    compartmentGrant:authority.compartmentGrant,projectGrant:authority.projectGrant}
  const rows = (await query<TemplateRow>(userId, `SELECT v.id AS "templateVersionId", t.name,
    jsonb_build_array(
      jsonb_build_object('sensitivity',t.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids),
      jsonb_build_object('sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids),
      jsonb_build_object('sensitivity',f.sensitivity,'compartments',f.compartments,'projectIds',f.project_ids)
    ) AS scopes
    FROM office_templates t JOIN office_template_versions v ON v.id=t.current_version_id AND v.template_id=t.id
    JOIN office_artifacts r ON r.id=t.draft_artifact_id AND r.workspace_id=t.workspace_id
    JOIN workspace_files f ON f.id=v.bundle_file_id AND f.workspace_id=t.workspace_id
    WHERE t.workspace_id=$1 AND t.family=$2 AND t.lifecycle_state='admitted' AND v.status='admitted'
      AND v.workspace_id=t.workspace_id AND r.mode='template' AND r.family=t.family
      AND r.lifecycle_state='active' AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
    ORDER BY t.name,t.id LIMIT 200`, [root.workspaceId,root.family])).rows
  return rows.filter(row => row.scopes.every(scope => within(scope,pinned) && within(scope,ceiling)))
    .map(({templateVersionId,name}) => ({templateVersionId,name}))
}

export async function readOfficeGenerationRecovery(userId: string, artifactId: string, jobId: string, ceiling: Ceiling = {}) {
  const {root,job,editable} = await read(userId,artifactId,jobId,defaultOfficeDbQuery)
  const policy = (await defaultOfficeDbQuery<{setupState:string}>(userId,
    'SELECT setup_state AS "setupState" FROM workspace_access_policies WHERE workspace_id=$1',[root.workspaceId])).rows[0]
  const canResumeTemplate = editable && root.mode === 'artifact' && root.headVersion === 0
    && job.jobKind === 'create' && job.status === 'needs_input' && job.errorCode === 'template_ambiguous'
    && (!policy || policy.setupState === 'legacy')
  return {canResumeTemplate,templateChoices: canResumeTemplate ? await choices(userId,root,job,defaultOfficeDbQuery,ceiling) : []}
}

export async function resumeOfficeGeneration(userId: string, raw: unknown) {
  const input = OfficeGenerationTemplateSelection.parse(raw)
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client,userId)
    const query: OfficeDbQuery = async <T>(actor: string, sql: string, params: unknown[]) => {
      if (actor !== userId) throw new Error('office_generation_recovery_actor_mismatch')
      return {rows:(await client.query(sql,params)).rows as T[]}
    }
    const discovered = await read(userId,input.artifactId,input.jobId,query)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[discovered.root.workspaceId])
    await client.query('SELECT id FROM office_artifacts WHERE id=$1 FOR UPDATE',[input.artifactId])
    await client.query('SELECT id FROM office_generation_jobs WHERE id=$1 FOR UPDATE',[input.jobId])
    const {root,job,editable} = await read(userId,input.artifactId,input.jobId,query)
    if (!editable || root.mode !== 'artifact') throw new WorkspaceAccessError('context_not_available',404)
    const policy = (await client.query<{setup_state:string}>(
      'SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1',[root.workspaceId])).rows[0]
    if (policy && policy.setup_state !== 'legacy') throw new WorkspaceAccessError('office_admission_provenance_required',409)
    // A lost acknowledgement may observe progress or completed publication.
    // It must never reset or run an already accepted selection again.
    if (job.templateVersionId === input.templateVersionId && ['queued','running','completed'].includes(job.status)) {
      await client.query('COMMIT')
      return {artifactId:input.artifactId,jobId:input.jobId}
    }
    const state = (await client.query<{blocked:boolean}>(`SELECT
      EXISTS(SELECT 1 FROM office_collab_documents WHERE artifact_id=$1) OR
      EXISTS(SELECT 1 FROM office_generation_jobs WHERE artifact_id=$1 AND id<>$2 AND created_at>=$3) OR
      EXISTS(SELECT 1 FROM office_generation_jobs WHERE id=$2 AND cancel_requested_at IS NOT NULL) AS blocked`,
      [input.artifactId,input.jobId,job.createdAt])).rows[0]
    if (root.headVersion !== 0 || job.jobKind !== 'create' || job.status !== 'needs_input'
      || job.errorCode !== 'template_ambiguous' || state?.blocked) throw conflict()
    // Lock every selected template authority row, then resolve its RLS-filtered
    // current version and the original execution ceiling again in this transaction.
    const sourceLock=(await client.query<{locked:boolean}>(
      'SELECT lock_office_generation_template_source($1,$2,$3) AS locked',
      [input.artifactId,input.jobId,input.templateVersionId])).rows[0]
    if(!sourceLock?.locked)throw conflict()
    if (!(await choices(userId,root,job,query)).some(choice => choice.templateVersionId === input.templateVersionId)) throw conflict()
    await client.query(`UPDATE office_artifacts SET template_version_id=$2,updated_at=now() WHERE id=$1`,[input.artifactId,input.templateVersionId])
    await client.query(`UPDATE office_generation_jobs SET status='queued',stage='queued',error_code=NULL,error_detail=NULL,
      template_version_id=$2::uuid,brief=jsonb_set(brief,'{templateId}',to_jsonb(($2::uuid)::text)),
      checkpoint='{}'::jsonb,checkpoint_version=0,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now(),updated_at=now()
      WHERE id=$1`,[input.jobId,input.templateVersionId])
    await createOfficeGenerationStore(query).appendEvent({userId,jobId:input.jobId,workspaceId:root.workspaceId,
      code:'office.job.template_resumed',values:{templateVersionId:input.templateVersionId},actorType:'user',actorUserId:userId})
    await client.query('COMMIT')
    return {artifactId:input.artifactId,jobId:input.jobId}
  } finally { await rollbackAndRelease(client) }
}
