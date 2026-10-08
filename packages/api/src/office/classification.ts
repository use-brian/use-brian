/** Add protection to an Office root. Shared human/Brian command. [COMP:api/office-classification] */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolContext } from '@use-brian/core'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { getAppPool, applyRLSGucs, rollbackAndRelease } from '../db/client.js'
import { defaultOfficeDbQuery } from '../db/office-artifacts.js'
import { OFFICE_ACCESS_SQL, resolveOfficeAccessProjection, type OfficeAccessProjection } from './access.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export const OfficeClassificationCommand = z.object({
  artifactId:z.string().uuid(), expectedRevision:z.string().regex(/^[a-f0-9]{64}$/),
  departmentId:z.string().uuid().optional(), sensitivity:z.enum(['public','internal','confidential']),
}).strict()
type OfficeClassificationInput = z.infer<typeof OfficeClassificationCommand>
type Root = {id:string; workspace_id:string; sensitivity:'public'|'internal'|'confidential'; compartments:string[]; project_ids:string[]; visibility_user_ids:string[]; head_version:string; mode:string}
const revision = (root:Root) => createHash('sha256').update(JSON.stringify([root.id,root.sensitivity,[...root.compartments].sort(),[...root.project_ids].sort(),[...root.visibility_user_ids].sort(),root.head_version])).digest('hex')
const denied = () => new WorkspaceAccessError('context_not_available',404)

export async function readOfficeClassification(userId:string, artifactId:string) {
  const root = (await defaultOfficeDbQuery<Root>(userId,'SELECT id,workspace_id,sensitivity,compartments,project_ids,visibility_user_ids,head_version,mode FROM office_artifacts WHERE id=$1',[artifactId])).rows[0]
  const projection = (await defaultOfficeDbQuery<OfficeAccessProjection>(userId,OFFICE_ACCESS_SQL,[artifactId,userId])).rows[0]
  const access = projection && resolveOfficeAccessProjection(userId,projection)
  if (!root || !access || root.mode === 'session') return null
  const history = (await defaultOfficeDbQuery<{id:string;createdAt:string;metadata:unknown}>(userId,`SELECT id,created_at AS "createdAt",metadata FROM office_audit_events WHERE artifact_id=$1 AND event_type='office.classification.restrict' ORDER BY created_at DESC,id DESC LIMIT 10`,[artifactId])).rows
  const departments=(await defaultOfficeDbQuery<{id:string;name:string}>(userId,'SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND compartment_key=ANY($2::text[]) ORDER BY name,id',[root.workspace_id,root.compartments])).rows
  return {departments,workspaceId:root.workspace_id,revision:revision(root),sensitivity:root.sensitivity,compartments:root.compartments,canManage:access.canManageSharing && access.canEdit,projectIds:root.project_ids,history}
}

export async function restrictOfficeClassification(userId:string, raw:OfficeClassificationInput) {
  const command = OfficeClassificationCommand.parse(raw)
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN'); await applyRLSGucs(client,userId)
    // Discovery is RLS-filtered; all writes then follow workspace -> root lock order.
    const found = (await client.query<{workspace_id:string}>('SELECT workspace_id FROM office_artifacts WHERE id=$1',[command.artifactId])).rows[0]
    if (!found) throw denied()
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[found.workspace_id])
    const root = (await client.query<Root>('SELECT id,workspace_id,sensitivity,compartments,project_ids,visibility_user_ids,head_version,mode FROM office_artifacts WHERE id=$1 FOR UPDATE',[command.artifactId])).rows[0]
    const projection = (await client.query<OfficeAccessProjection>(OFFICE_ACCESS_SQL,[command.artifactId,userId])).rows[0]
    const access = projection && resolveOfficeAccessProjection(userId,projection)
    if (!root || root.mode === 'session' || !access?.canManageSharing || !access.canEdit) throw denied()
    if (revision(root) !== command.expectedRevision) throw new WorkspaceAccessError('office_classification_changed',409)
    if ((await client.query("SELECT 1 FROM office_generation_jobs WHERE artifact_id=$1 AND status IN ('queued','running','needs_input') LIMIT 1",[root.id])).rows.length) throw new WorkspaceAccessError('office_classification_job_active',409)
    const tiers=['public','internal','confidential']
    if (tiers.indexOf(command.sensitivity)<tiers.indexOf(root.sensitivity)) throw new WorkspaceAccessError('office_classification_floor',409)
    const admitted = await admitWorkspaceResource(client,root.workspace_id,userId,{
      visibility:root.visibility_user_ids.length?'private':'workspace',sensitivity:command.sensitivity,
      inherited:{visibility:root.visibility_user_ids.length?'private':'workspace',sensitivity:root.sensitivity,compartments:root.compartments,projectIds:root.project_ids},
      ...(command.departmentId ? {destination:{kind:'department' as const,departmentId:command.departmentId}} : root.compartments.length ? {requestedLabels:{compartments:root.compartments}} : {destination:{kind:'general' as const}}),
    })
    const after=admitted.envelope
    if (!root.compartments.every(c=>after.compartments.includes(c)) || !root.project_ids.every(p=>after.projectIds.includes(p))) throw denied()
    if(after.sensitivity===root.sensitivity && JSON.stringify([...after.compartments].sort())===JSON.stringify([...root.compartments].sort())) {
      await client.query('COMMIT');return {artifactId:root.id,sensitivity:root.sensitivity,compartments:root.compartments,projectIds:root.project_ids}
    }
    const updated = await client.query(`UPDATE office_artifacts SET sensitivity=$2,compartments=$3,updated_at=now() WHERE id=$1 RETURNING id`,[root.id,after.sensitivity,after.compartments])
    if (!updated.rows.length) throw denied()
    await client.query(`INSERT INTO office_audit_events(workspace_id,artifact_id,actor_user_id,event_type,artifact_version,metadata)
      VALUES($1,$2,$3,'office.classification.restrict',$4,$5::jsonb)`,[root.workspace_id,root.id,userId,root.head_version,JSON.stringify({before:{sensitivity:root.sensitivity,compartments:root.compartments},after:{sensitivity:after.sensitivity,compartments:after.compartments}})])
    await client.query('COMMIT')
    return {artifactId:root.id,sensitivity:after.sensitivity,compartments:after.compartments,projectIds:root.project_ids}
  } finally { await rollbackAndRelease(client) }
}

/** Never reinterpret an unbound assistant call as an unrestricted human write. */
export function withOfficeClassificationActor<T>(actor:ToolContext, action:()=>Promise<T>):Promise<T> {
  const ceiling=actor.executionContext?.security.ceiling
  const department=actor.executionContext?.security.access?.departmentRead
  if(!ceiling || !department || department.userId!==actor.userId || department.workspaceId!==actor.workspaceId || department.assistantId!==actor.assistantId) throw denied()
  return runWithAgentAccess({...ceiling,departmentRead:department},action)
}
