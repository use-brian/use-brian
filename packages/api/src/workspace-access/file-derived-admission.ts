import type { PoolClient } from 'pg'
import { deriveResourceScope, resourceScopeKey, type ScopeSource, type AccessContext, type DerivedWriteEvidence, type WorkspaceFileCreateInput } from '@use-brian/core'
import { validateDerivedEntityInputs } from '../db/derived-scope-store.js'
import { assertExecutionResourceScope } from '../db/access-predicate.js'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource } from './resource-admission.js'

/** Expand only canonical dependencies after validating the exact observed inputs. */
export async function expandDerivedFileEvidence(client: PoolClient, evidence: DerivedWriteEvidence): Promise<DerivedWriteEvidence> {
  const sources=new Map<string,ScopeSource>()
  let pending:ScopeSource[]=[]
  const add=(source:ScopeSource)=>{
    const key=`${source.workspaceId}:${source.resourceKind}:${source.resourceId}`
    const previous=sources.get(key)
    if(previous){
      if(previous.version!==source.version||resourceScopeKey(previous)!==resourceScopeKey(source))throw new Error('scope_source_changed')
      return
    }
    sources.set(key,source);pending.push(source)
  }
  evidence.sources.forEach(add)
  // Empty evidence and malformed/mixed workspace inputs retain the existing refusal.
  const floor=await validateDerivedEntityInputs(client,evidence)
  while(pending.length){
    const batch=pending.sort((a,b)=>`${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`))
    pending=[]
    await validateDerivedEntityInputs(client,{...evidence,sources:[...sources.values()]})
    const {rows}=await client.query<{source:{requiredSources?:ScopeSource[]}|null}>(
      `SELECT read_entity_derivation_source($1,t.kind,t.id) AS source
       FROM unnest($2::text[],$3::uuid[]) t(kind,id)`,
      [floor.workspaceId,batch.map(s=>s.resourceKind),batch.map(s=>s.resourceId)])
    if(rows.length!==batch.length)throw new Error('scope_source_changed')
    for(const {source} of rows){
      if(!source)throw new Error('scope_source_changed')
      if(source.requiredSources!==undefined&&!Array.isArray(source.requiredSources))throw new Error('scope_evidence_missing')
      for(const dependency of source.requiredSources??[])add(dependency)
    }
  }
  return {...evidence,sources:[...sources.values()]}
}

/** Internal per-call evidence, never transport metadata or an ambient default. */
export async function admitDerivedFile(client: PoolClient, actor: string, input: WorkspaceFileCreateInput,
  evidence: DerivedWriteEvidence, access?: AccessContext, expectedRevision?: string) {
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
  const policy = await readAdmissionPolicy(client, input.workspaceId)
  if (expectedRevision !== undefined && expectedRevision !== policy?.revision) throw new Error('access_policy_conflict')
  if (input.createdByUserId !== actor || input.compartments === null || input.projectIds === null) throw new Error('scope_evidence_missing')
  const floor = await validateDerivedEntityInputs(client, evidence)
  if (floor.workspaceId !== input.workspaceId) throw new Error('scope_workspace_mismatch')
  if (input.sourceEpisodeId && !evidence.sources.some(s => s.resourceKind === 'episode' && s.resourceId === input.sourceEpisodeId)) throw new Error('scope_evidence_missing')
  // Session/page paths need their own canonical binding; generic source evidence
  // does not establish that binding, even if it contains compatible labels.
  if (/^\/(?:office|doc)\//.test(input.path) || input.metadata?.sessionId || input.metadata?.officeSession) throw new Error('scope_evidence_missing')
  for (const source of evidence.sources) assertExecutionResourceScope(source, 'read', access)
  const scope = deriveResourceScope(evidence, { workspaceId: input.workspaceId,
    userId: input.userId ?? null, assistantId: input.assistantId ?? null,
    sensitivity: input.sensitivity ?? 'internal', compartments: input.compartments ?? [], projectIds: input.projectIds ?? [] })
  assertExecutionResourceScope(scope, 'read', access)
  assertExecutionResourceScope({ ...scope, compartments: scope.compartments.filter(k => !floor.compartments.includes(k)) }, 'mutation', access)
  if (policy && policy.setupState !== 'legacy') await admitWorkspaceResource(client, input.workspaceId, actor, {
    writerKind: 'workspace_file', rowVisibility: { userId: scope.userId, assistantId: scope.assistantId },
    visibility: scope.userId ? 'private' : 'workspace', sensitivity: scope.sensitivity,
    inherited: { ...floor, visibility: floor.userId ? 'private' : 'workspace' }, inheritedAuthority: 'read',
    requestedLabels: { compartments: input.compartments?.length ? input.compartments : undefined, projectIds: input.projectIds },
  })
  return { ...input, ...scope }
}
