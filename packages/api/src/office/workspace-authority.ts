/** Native Office jobs retain the host-observed external connection. [COMP:api/office-generation] */
import { workspaceCredentialDelegation, type ToolContext } from '@use-brian/core'
import { restoreWorkspaceMcpDelegation } from '../workspace-mcp/delegation.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { runWithAgentAccess } from '../db/client.js'
import { createAuthorityLease, runWithAuthorityLease } from '../context-scope/authority-lease.js'
import { bindWorkspaceMcpPublication } from '../db/session-context-revisions.js'
import { assertSourceModelInputAuthority, assertSourceModelOutputAuthority } from '../application-platform/model-source-authority.js'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

type Origin = {workspaceDelegation?: import('@use-brian/core').WorkspaceCredentialDelegation;workspaceEvidence?:import('@use-brian/core').ScopeEvidence}
export async function captureOfficeWorkspaceAuthority(context?:ToolContext):Promise<Origin> {
  const parent=workspaceCredentialDelegation(context?.executionContext)
  if(!parent)return {}
  await context!.executionContext!.security.authority.assertCurrent()
  return {workspaceDelegation:parent,workspaceEvidence:structuredClone(context!.scopeAccumulator?.evidence ?? context!.executionContext!.security.provenance)}
}

/** Called before model work and each publication boundary, never while holding Office SQL locks. */
export async function withOfficeWorkspaceAuthority<T>(job:OfficeGenerationJobRow,operation:()=>Promise<T>):Promise<T> {
  const origin=job.authorityProjection as Origin|null
  if(!origin?.workspaceDelegation)return operation()
  const parent=origin.workspaceDelegation
  if(parent.userId!==job.initiatedByUserId || parent.workspaceId!==job.workspaceId)throw new Error('office_workspace_authority_changed')
  const {context}=await restoreWorkspaceMcpDelegation(parent,createDbCapabilityStore())
  const execution=context.executionContext!
  bindWorkspaceMcpPublication(execution)
  context.scopeAccumulator!.note(origin.workspaceEvidence)
  await assertSourceModelInputAuthority(context)
  const lease = createAuthorityLease(execution.security.ceiling,async()=>{await execution.security.authority.assertCurrent();return execution.security.ceiling})
  return runWithAuthorityLease(lease,()=>runWithAgentAccess(execution.security.access,async()=>{
    await execution.security.authority.assertCurrent()
    const result=await operation()
    await execution.security.authority.assertCurrent()
    await assertSourceModelOutputAuthority(context)
    return result
  }))
}
