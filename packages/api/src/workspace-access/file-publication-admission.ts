import {authorizePendingPdfIntake} from '../db/office-pdf-intake.js'
import type { PoolClient } from 'pg'
import { scopeGrantContains, maxSensitivity, unionScopeRequirements, type AccessContext, type ResourceScope, type WorkspaceFileCreateInput } from '@use-brian/core'
import { assertExecutionResourceScope } from '../db/access-predicate.js'
import { createDbContextScopeStore } from '../db/context-scope-store.js'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

export type FileSessionBinding = { pending?: boolean; artifactId: string; snapshot: string; scope: ResourceScope }
export type FileUploadBinding = ResourceScope & { ready?: boolean; executingAssistantId?: string | null }
export async function assertCurrentFileAssistant(client:PoolClient,scope:ResourceScope,access?:AccessContext) {
  if (!access?.assistantId) return
  const assistant=(await client.query('SELECT clearance FROM assistants WHERE id=$1 AND workspace_id=$2 FOR SHARE',[access.assistantId,scope.workspaceId])).rows[0]
  const principal=await createDbContextScopeStore(client).resolveAssistantPrincipalSystem(access.assistantId,scope.workspaceId)
  const rank={public:0,internal:1,confidential:2} as const
  if (!assistant || !principal || rank[scope.sensitivity]>rank[assistant.clearance as keyof typeof rank]
    || !scopeGrantContains(principal.teamGrant,scope.compartments) || !scopeGrantContains(principal.projectGrant,scope.projectIds)) throw denied()
}
const denied = () => new WorkspaceAccessError('context_not_available', 404)

export async function readFileSessionBinding(client: PoolClient, actor: string, workspaceId: string, path: string, access?: AccessContext): Promise<FileSessionBinding> {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  const artifactId = /^\/office\/sessions\/([0-9a-f-]{36})\//i.exec(path)?.[1]
  if (!artifactId) throw denied()
  await authorizePendingPdfIntake(client,actor,workspaceId,artifactId)
  const row = (await client.query(`SELECT a.id,a.owner_user_id,a.sensitivity,a.compartments,a.project_ids,a.pdf_intake_state,
    jsonb_build_array(a.id,a.workspace_id,a.owner_user_id,a.head_version_id,a.head_version,a.updated_at,a.expires_at,
      a.sensitivity,a.compartments,a.project_ids)::text AS snapshot
    FROM office_artifacts a WHERE a.id=$1 AND a.workspace_id=$2 AND a.owner_user_id=$3
      AND a.mode='session' AND a.family='pdf' AND a.lifecycle_state='active' AND a.expires_at>now()
      AND NOT scope_review_state_held('office_artifact',a.id)
      AND office_artifact_scope_allows(a.id,a.workspace_id,true) FOR SHARE OF a`, [artifactId,workspaceId,actor])).rows[0]
  if (!row) throw denied()
  const scope: ResourceScope = { workspaceId,userId:row.owner_user_id,assistantId:null,
    sensitivity:row.sensitivity,compartments:row.compartments,projectIds:row.project_ids }
  await assertCurrentFileAssistant(client,scope,access)
  assertExecutionResourceScope(scope,'read',access)
  assertExecutionResourceScope(scope,'mutation',access)
  return { artifactId:row.id,snapshot:row.snapshot,scope,pending:row.pdf_intake_state==='pending' }
}

/** The binding is a snapshot returned by our app-role reader, not path evidence.
 * Re-read it after storage I/O while holding the canonical writer transaction. */
export async function admitSessionFile(client: PoolClient, actor: string, input: WorkspaceFileCreateInput, expected: FileSessionBinding, access?: AccessContext) {
  const current = await readFileSessionBinding(client,actor,input.workspaceId,input.path,access)
  if (current.artifactId!==expected.artifactId || current.snapshot!==expected.snapshot) throw new WorkspaceAccessError('access_policy_conflict',409)
  if (input.createdByUserId!==actor || (input.userId && input.userId!==actor) || input.assistantId || input.sourceEpisodeId) throw denied()
  const after = { ...input, userId:actor,assistantId:null,
    sensitivity:maxSensitivity(current.scope.sensitivity,input.sensitivity??'internal'),
    compartments:unionScopeRequirements(current.scope.compartments,input.compartments),
    projectIds:unionScopeRequirements(current.scope.projectIds,input.projectIds),
    metadata:{...input.metadata,officeSession:true,noIndex:true} }
  await admitBoundFile(client,actor,after,current.scope,access)
  return after
}

async function admitBoundFile(client: PoolClient, actor: string, input: WorkspaceFileCreateInput, inherited: ResourceScope, access?: AccessContext) {
  assertExecutionResourceScope({...inherited,sensitivity:input.sensitivity??inherited.sensitivity,
    compartments:input.compartments??inherited.compartments,projectIds:input.projectIds??inherited.projectIds},'mutation',access)
  await assertCurrentFileAssistant(client,{...inherited,sensitivity:input.sensitivity??inherited.sensitivity,compartments:input.compartments??inherited.compartments,projectIds:input.projectIds??inherited.projectIds},access)
  // A staged binding is not grandfathered authority over archived destinations.
  for (const id of input.projectIds??inherited.projectIds) {
    if (!(await client.query("SELECT id FROM workspace_projects WHERE id=$1 AND workspace_id=$2 AND status='active'",[id,input.workspaceId])).rows.length) throw denied()
  }
  for (const key of input.compartments??inherited.compartments) {
    if (key.startsWith('team:') && !(await client.query("SELECT id FROM workspace_groups WHERE compartment_key=$1 AND workspace_id=$2 AND kind='team' AND status='active'",[key,input.workspaceId])).rows.length) throw denied()
  }
  const policy=await readAdmissionPolicy(client,input.workspaceId)
  if (policy && policy.setupState!=='legacy') await admitWorkspaceResource(client,input.workspaceId,actor,{
    writerKind:'workspace_file',rowVisibility:{userId:input.userId??null,assistantId:input.assistantId??null},
    visibility:input.userId?'private':'workspace',sensitivity:input.sensitivity??inherited.sensitivity,
    inherited:{...inherited,visibility:inherited.userId?'private':'workspace'},
    requestedLabels:{compartments:input.compartments?.length?input.compartments:undefined,projectIds:input.projectIds},
  })
}

export async function admitUploadedFile(client: PoolClient, actor: string, input: WorkspaceFileCreateInput, uploadId: string, access?: AccessContext) {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[input.workspaceId])
  const upload=(await client.query(`SELECT * FROM workspace_file_uploads WHERE id=$1 AND workspace_id=$2
    AND acting_user_id=$3 AND status='assembling' AND expires_at>now() FOR UPDATE`,[uploadId,input.workspaceId,actor])).rows[0]
  if (!upload || !upload.admission_binding || upload.file_id!==input.id || upload.path!==input.path
    || upload.storage_uri!==input.storageUri || Number(upload.size_bytes)!==input.sizeBytes
    || (upload.assistant_id && upload.assistant_id!==access?.assistantId)) throw denied()
  const binding:FileUploadBinding=upload.admission_binding
  if (binding.executingAssistantId && binding.executingAssistantId!==access?.assistantId) throw denied()
  const policy=await readAdmissionPolicy(client,input.workspaceId)
  if (policy?.setupState==='ready' && !binding.ready) throw new WorkspaceAccessError('access_policy_conflict',409)
  const after={...input,...binding,createdByUserId:actor,createdByAssistantId:null}
  await admitBoundFile(client,actor,after,binding,access)
  return after
}
