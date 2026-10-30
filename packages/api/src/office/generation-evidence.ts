/** Canonical Office source floors for the department engine. [COMP:api/organization-cutover] */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { classifyOfficeOutput, type OfficeOutputScope } from './file-binding.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { canRead, parseAuthoringAuthority } from '@use-brian/core'
import { assertExecutionResourceScope } from '../db/access-predicate.js'
import { getAppPool, applyRLSGucs, rollbackAndRelease } from '../db/client.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'

type Source = OfficeOutputScope & { id: string; kind: string; version: string; private: boolean; artifactId?:string }
export type OfficeGenerationEvidence = { sources: Source[]; scope: OfficeOutputScope; private: boolean; fingerprint: string }
const missing = () => new WorkspaceAccessError('office_source_unavailable', 404)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The caller holds the workspace lock. These are application-role reads, not
 * user-supplied labels or an owner-pool source bypass. Publication still checks
 * current source access and inherits the material the generation actually reads. */
export async function readOfficeGenerationEvidence(client: PoolClient, workspaceId: string,
  input: { templateId?: string | null; sourceHandles?: string[] }): Promise<OfficeGenerationEvidence> {
  const sources: Source[] = []
  if (input.templateId) {
    if (!uuid.test(input.templateId)) throw missing()
    const template = (await client.query<{ id: string; version: string; sensitivity: OfficeOutputScope['sensitivity']; compartments: string[]; projectIds: string[]; private: boolean; bundle: string; artifactId:string }>(`
      SELECT v.id,(v.version::text||':'||v.bundle_hash||':'||coalesce(to_jsonb(a)->>'scope_version',a.updated_at::text)) AS version,
        CASE WHEN sensitivity_rank(t.sensitivity)>sensitivity_rank(a.sensitivity) THEN t.sensitivity ELSE a.sensitivity END AS sensitivity,
        a.compartments,a.project_ids AS "projectIds",
        (cardinality(a.visibility_user_ids)>0 OR cardinality(a.visibility_assistant_ids)>0
          OR cardinality(t.visibility_user_ids)>0 OR a.default_workspace_role='deny') AS private,
        v.bundle_file_id AS bundle,a.id AS "artifactId"
      FROM office_template_versions v JOIN office_templates t ON t.id=v.template_id AND t.workspace_id=v.workspace_id
      JOIN office_artifacts a ON a.id=t.draft_artifact_id AND a.workspace_id=t.workspace_id
      WHERE v.id=$2 AND v.workspace_id=$1 AND v.status='admitted' AND t.lifecycle_state='admitted'
        AND a.mode='template' AND a.lifecycle_state='active'
        AND office_template_version_scope_allows(v.id,v.workspace_id,false)`, [workspaceId,input.templateId])).rows[0]
    if (!template) throw missing()
    sources.push({ id: template.id, kind: 'template', version: template.version,
      sensitivity: template.sensitivity, compartments: template.compartments, projectIds: template.projectIds, private: template.private,artifactId:template.artifactId })
    const files = (await client.query<Source>(`
      SELECT f.id,'file'::text AS kind,(f.scope_version::text||':'||f.xmin::text) AS version,f.sensitivity,
        f.compartments,f.project_ids AS "projectIds",(f.user_id IS NOT NULL OR f.assistant_id IS NOT NULL) AS private
      FROM workspace_files f WHERE f.workspace_id=$1 AND (f.id=$2 OR f.id IN (
        SELECT r.file_id FROM office_template_resource_refs ref JOIN office_resources r ON r.id=ref.resource_id
        WHERE ref.template_version_id=$3 AND ref.workspace_id=$1 AND r.workspace_id=$1))
        AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
      ORDER BY f.id`, [workspaceId,template.bundle,input.templateId])).rows
    if (!files.some(file => file.id === template.bundle)) throw missing()
    sources.push(...files)
    const resources = (await client.query<Source>(`
      SELECT r.id,'resource'::text AS kind,r.content_hash AS version,r.sensitivity,
        '{}'::text[] AS compartments,'{}'::uuid[] AS "projectIds",false AS private
      FROM office_template_resource_refs ref JOIN office_resources r ON r.id=ref.resource_id AND r.workspace_id=ref.workspace_id
      WHERE ref.template_version_id=$2 AND ref.workspace_id=$1 ORDER BY r.id`, [workspaceId,input.templateId])).rows
    const referenced=(await client.query<{id:string}>(`SELECT r.file_id AS id FROM office_template_resource_refs ref JOIN office_resources r ON r.id=ref.resource_id AND r.workspace_id=ref.workspace_id WHERE ref.template_version_id=$2 AND ref.workspace_id=$1`,[workspaceId,input.templateId])).rows
    if(referenced.some(resource=>!files.some(file=>file.id===resource.id)))throw missing()
    sources.push(...resources)
  }
  for (const handle of [...new Set(input.sourceHandles ?? [])].sort()) {
    const match = /^knowledge:([0-9a-f-]{36})$/i.exec(handle)
    if (!match || !uuid.test(match[1]!)) throw new WorkspaceAccessError('office_source_handle_unsupported', 409)
    const source = (await client.query<Source>(`SELECT id,'knowledge'::text AS kind,(scope_version::text||':'||xmin::text) AS version,
      sensitivity,compartments,project_ids AS "projectIds",false AS private FROM knowledge_entries
      WHERE id=$2 AND workspace_id=$1 AND NOT scope_held
        AND office_labels_scope_allows(workspace_id,sensitivity,compartments,project_ids,'{}','{}',false)`, [workspaceId,match[1]])).rows[0]
    if (!source) throw missing()
    sources.push(source)
  }
  const ordered = sources.sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
  return { sources: ordered, scope: classifyOfficeOutput(...ordered), private: ordered.some(source => source.private),
    fingerprint: createHash('sha256').update(JSON.stringify(ordered)).digest('hex') }
}

/** A persisted job is not fresh authority. This check runs at claim and again
 * at publication, under the same app-role identity as the Office mutation. */
export async function validateDepartmentOfficeGeneration(client: PoolClient,
  job: import('../db/office-generation.js').OfficeGenerationJobRow) {
  const projection = job.authorityProjection as {creationBinding?:{protocol?:string;actorUserId?:string;workspaceId?:string;authSessionId?:string;sourceFingerprint?:string;authoringAuthority?:unknown;ambientSourceHandles?:string[]}}
  const binding = projection.creationBinding
  if (binding?.protocol !== 'office_department_v2') return
  if (binding.actorUserId !== job.initiatedByUserId || binding.workspaceId !== job.workspaceId || !binding.authSessionId) throw missing()
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[job.workspaceId])
  const live = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
    JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$3
    WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND s.auth_version=u.auth_version FOR SHARE OF s,u,m`,[binding.authSessionId,job.initiatedByUserId,job.workspaceId])
  if (!live.rows.length) throw missing()
  const brief=job.brief as {templateId?:string;sourceHandles?:string[]}
  const current=await readOfficeGenerationEvidence(client,job.workspaceId,{...brief,sourceHandles:[...(brief.sourceHandles??[]),...(binding.ambientSourceHandles??[])]})
  if (current.fingerprint !== binding.sourceFingerprint) throw new WorkspaceAccessError('office_source_changed',409)
  const authority=parseAuthoringAuthority(binding.authoringAuthority)
  if (!authority || authority.assistantId!==job.assistantId) throw missing()
  const root=(await client.query<{sensitivity:OfficeOutputScope['sensitivity'];compartments:string[];projectIds:string[];visibilityUserIds:string[]}>(`
    SELECT sensitivity,compartments,project_ids AS "projectIds",visibility_user_ids AS "visibilityUserIds"
    FROM office_artifacts WHERE id=$1 AND workspace_id=$2 AND mode='artifact' AND lifecycle_state='active'
      AND office_generation_artifact_allows(id,workspace_id,true)`,[job.artifactId,job.workspaceId])).rows[0]
  if (!root) throw missing()
  if(!canRead(root.sensitivity,current.scope.sensitivity)
    ||current.scope.compartments.some(key=>!root.compartments.includes(key))
    ||current.scope.projectIds.some(id=>!root.projectIds.includes(id))
    ||current.private&&!root.visibilityUserIds.includes(job.initiatedByUserId))throw new WorkspaceAccessError('office_source_floor_changed',409)
  const departments=root.compartments.filter(key=>key.startsWith('team:')).map(key=>key.slice(5))
  const {resolveWorkflowAuthoringScope}=await import('../context-scope/workflow-authority.js')
  const scope=await resolveWorkflowAuthoringScope({userId:job.initiatedByUserId,workspaceId:job.workspaceId,
    assistantId:authority.assistantId,authoringAuthority:authority,
    contextGroupId:departments.length===1?departments[0]!:null,
    contextProjectId:root.projectIds.length===1?root.projectIds[0]!:null},client)
  assertExecutionResourceScope({workspaceId:job.workspaceId,userId:root.visibilityUserIds.length?job.initiatedByUserId:null,
    assistantId:null,sensitivity:root.sensitivity,compartments:root.compartments,projectIds:root.projectIds},'read',scope.access)
  return scope.access
}

export async function withDepartmentOfficeGeneration<T>(job: import('../db/office-generation.js').OfficeGenerationJobRow,
  run: () => Promise<T>): Promise<T> {
  const protocol=(job.authorityProjection as {creationBinding?:{protocol?:string}})?.creationBinding?.protocol
  if (protocol!=='office_department_v2') return run()
  const client=await getAppPool().connect()
  let access: Awaited<ReturnType<typeof validateDepartmentOfficeGeneration>>
  try {
    await client.query('BEGIN');await applyRLSGucs(client,job.initiatedByUserId)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[job.workspaceId])
    const live=await client.query(`SELECT 1 FROM office_generation_jobs WHERE id=$1 AND workspace_id=$2
      AND initiated_by_user_id=$3 AND status='running' AND lease_token=$4 AND lease_expires_at>clock_timestamp()
      AND cancel_requested_at IS NULL FOR UPDATE`,[job.id,job.workspaceId,job.initiatedByUserId,job.leaseToken])
    if (!live.rows.length) throw missing()
    access=await validateDepartmentOfficeGeneration(client,job)
    await client.query('COMMIT')
  } finally {await rollbackAndRelease(client)}
  if (!access?.clearance || access.compartments===undefined || access.projectIds===undefined) throw missing()
  return runWithAgentAccess({...access,clearance:access.clearance,compartments:access.compartments},run)
}

/** Bind the exact ambient knowledge already returned by scoped retrieval. A
 * concurrent edit cannot become unreviewed evidence: compare its full excerpt
 * and envelope under the publication workspace lock before accepting it. */
export async function bindDepartmentOfficeKnowledge(job: import('../db/office-generation.js').OfficeGenerationJobRow,
 entries: Array<{handle:string;excerpt:string;sensitivity:string;compartments?:string[];projectIds?:string[]}>) {
 const projection=job.authorityProjection as {creationBinding?:{protocol?:string;ambientSourceHandles?:string[];sourceFingerprint?:string;sources?:Source[]}}
 if(projection.creationBinding?.protocol!=='office_department_v2')return
 const c=await getAppPool().connect()
 try {
  await c.query('BEGIN');await applyRLSGucs(c,job.initiatedByUserId)
  await validateDepartmentOfficeGeneration(c,job)
  const live=await c.query(`SELECT 1 FROM office_generation_jobs WHERE id=$1 AND status='running' AND lease_token=$2
   AND lease_expires_at>clock_timestamp() AND cancel_requested_at IS NULL FOR UPDATE`,[job.id,job.leaseToken])
  if(!live.rowCount)throw missing()
  for(const entry of entries) {
   const id=/^knowledge:([0-9a-f-]{36})$/i.exec(entry.handle)?.[1]
   if(!id||!uuid.test(id))throw missing()
   const row=(await c.query(`SELECT title,summary,content,sensitivity,compartments,project_ids FROM knowledge_entries
    WHERE id=$1 AND workspace_id=$2 AND NOT scope_held`,[id,job.workspaceId])).rows[0]
   if(!row||[row.title,row.summary,row.content].filter(Boolean).join('\n').slice(0,4000)!==entry.excerpt
    ||row.sensitivity!==entry.sensitivity||JSON.stringify(row.compartments)!==JSON.stringify(entry.compartments??[])
    ||JSON.stringify(row.project_ids)!==JSON.stringify(entry.projectIds??[]))throw new WorkspaceAccessError('office_source_changed',409)
  }
  const handles=[...new Set([...(projection.creationBinding.ambientSourceHandles??[]),...entries.map(entry=>entry.handle)])].sort()
  const brief=job.brief as {templateId?:string;sourceHandles?:string[]}
  const evidence=await readOfficeGenerationEvidence(c,job.workspaceId,{...brief,sourceHandles:[...(brief.sourceHandles??[]),...handles]})
  const next={...projection,creationBinding:{...projection.creationBinding,ambientSourceHandles:handles,sourceFingerprint:evidence.fingerprint,sources:evidence.sources}}
  await c.query('UPDATE office_generation_jobs SET authority_projection=$2::jsonb WHERE id=$1',[job.id,JSON.stringify(next)])
  await c.query('COMMIT');job.authorityProjection=next
 }finally{await rollbackAndRelease(c)}
}
