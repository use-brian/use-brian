/** Current native source, capability and registry eligibility at human apply.
 * [COMP:api/routine-proposals]
 */
import { pinAccessCeiling, type Tool, type TurnScope } from '@use-brian/core'
import { captureAuthoringAuthoritySystem, resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { RoutineConfigurationError, type RoutinePreflightInput } from './routine-proposals.js'

export async function assertRoutineRuntimeReady(input:Omit<RoutinePreflightInput,'authority'>, runtime:{
  buildRegistry:(params:{userId:string;workspaceId:string;assistantId:string;turnScope:TurnScope})=>Promise<Map<string,Tool>>
  usableAccounts:(registry:Map<string,Tool>)=>Promise<Set<string>>
}) {
  const {userId,workspaceId,configuration,sourceEvidence}=input
  const executor=configuration.definition.defaultExecutor
  if (executor?.kind!=='assistant') return
  const selected=await captureAuthoringAuthoritySystem({userId,workspaceId,assistantId:executor.assistantId,
    contextGroupId:configuration.contextGroupId,contextProjectId:configuration.contextProjectId})
  const turnScope=await resolveWorkflowAuthoringScope({userId,workspaceId,assistantId:executor.assistantId,authoringAuthority:selected,
    contextGroupId:configuration.contextGroupId,contextProjectId:configuration.contextProjectId})
  await validateCallerScopeEvidence(sourceEvidence,pinAccessCeiling(turnScope.access))
  const registry=await runtime.buildRegistry({userId,workspaceId,assistantId:executor.assistantId,turnScope})
  const capabilities=new Set(await createDbCapabilityStore().listActive(executor.assistantId))
  for (const name of configuration.definition.taskIntake?.permittedActions ?? []) {
    const tool=registry.get(name)
    if (!tool || tool.requiresCapability && !capabilities.has(tool.requiresCapability)) throw new RoutineConfigurationError('routine_dependencies_unavailable')
  }
  const accounts=await runtime.usableAccounts(registry)
  if (configuration.definition.taskIntake?.requiredAccounts.some(name=>!accounts.has(name))) throw new RoutineConfigurationError('routine_dependencies_unavailable')
}
