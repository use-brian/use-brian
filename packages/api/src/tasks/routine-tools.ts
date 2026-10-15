/** Brian and agent-surface adapters over the canonical routine commands.
 * [COMP:api/routine-proposals]
 */
import { z } from 'zod'
import { buildTool, provenanceSessionId, CONFIGURE_CAPABILITY, ContextScopeAccumulator, type ScopeEvidence, type Tool, type ToolContext } from '@use-brian/core'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { getPool } from '../db/client.js'
import { applyRoutineProposal, inspectRoutineConfiguration, inspectRoutineProposal, listRoutineProposals,
  prepareNewRoutineProposal, prepareRoutineProposal, rejectRoutineProposal, routineProposalCommandSchema,
  RoutineConfigurationError, setRoutineIntakeEnabled, type RoutineApplyActor } from './routine-proposals.js'

export const isRoutineDecisionTool = (name: string) => ['applyRoutineIntake','rejectRoutineIntake','setRoutineIntakeEnabled'].includes(name)

function humanActor(context: ToolContext): RoutineApplyActor {
  if (context.programmaticPrincipal) throw new RoutineConfigurationError('routine_human_apply_required',403)
  if (context.approvedStagedWrite) return {kind:'staged',userId:context.approvedStagedWrite.approverUserId,
    approvalId:context.approvedStagedWrite.approvalId,authSessionId:context.approvedStagedWrite.authSessionId}
  if (context.approvedToolInvocation) return {kind:'tool',userId:context.approvedToolInvocation.approverUserId,
    approvalId:context.approvedToolInvocation.approvalId}
  throw new RoutineConfigurationError('routine_human_apply_required',403)
}

async function run(context: ToolContext, configure: boolean, operation: (workspaceId: string) => Promise<unknown>) {
  if (!context.workspaceId) return {data:'Choose a workspace before inspecting or proposing routine intake.',isError:true as const}
  try {
    if (configure && !(await createDbCapabilityStore().listActive(context.assistantId)).includes(CONFIGURE_CAPABILITY)) {
      return {data:'Routine authoring is unavailable for this assistant. Offer the suggestion in conversation for a person to review.',isError:true as const}
    }
    const value = await operation(context.workspaceId)
    const evidence = new ContextScopeAccumulator()
    const groups = new Set<string>()
    const note = (entry: unknown) => {
      const row = entry as {arguments?:{sourceEvidence?:ScopeEvidence;before?:{contextGroupId?:string;contextProjectId?:string};after?:{contextGroupId?:string;contextProjectId?:string}};
        configuration?:{contextGroupId?:string;contextProjectId?:string};sourceEvidence?:ScopeEvidence}
      evidence.note(row.arguments?.sourceEvidence ?? row.sourceEvidence)
      for (const scope of [row.arguments?.before,row.arguments?.after,row.configuration]) {
        if (scope?.contextGroupId) groups.add(scope.contextGroupId)
        if (scope?.contextProjectId) evidence.noteProjectIds([scope.contextProjectId])
      }
    }
    note(value)
    const listed = (value as {proposals?:unknown[]})?.proposals
    if (listed) listed.forEach(note)
    if (groups.size) for (const row of (await getPool().query<{compartment_key:string}>(
      'SELECT compartment_key FROM workspace_groups WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND compartment_key IS NOT NULL', [context.workspaceId,[...groups]])).rows) {
      evidence.noteCompartments([row.compartment_key])
    }
    return {data:value as object,scopeEvidence:evidence.evidence}
  } catch (error) {
    if (error instanceof RoutineConfigurationError) return {data:{error:error.code,changed:false},isError:true as const}
    if ((error as {reason?:string}).reason==='caller_evidence_unavailable') return {data:{error:'routine_not_found',changed:false},isError:true as const}
    throw error
  }
}

export function createRoutineTools(): Record<'getRoutineIntake'|'proposeRoutineIntake'|'applyRoutineIntake'|'rejectRoutineIntake'|'setRoutineIntakeEnabled',Tool> {
  const getRoutineIntake = buildTool({ name:'getRoutineIntake',isReadOnly:true,isConcurrencySafe:true,
    description:'Inspect source-admitted routine configuration with workflow_id, or an exact inactive proposal with proposal_id. With neither, list pending routine proposals you can review. A disabled routine stops new intake; existing Tasks retain their own mandate and allowance.',
    inputSchema:z.object({workflow_id:z.string().uuid().optional(),proposal_id:z.string().uuid().optional()}).strict(),
    execute:(input,context)=>run(context,false,async workspaceId=>{
      if (input.workflow_id && input.proposal_id) throw new RoutineConfigurationError('routine_configuration_invalid',400)
      const value = input.proposal_id ? await inspectRoutineProposal(context.userId,input.proposal_id)
        : input.workflow_id ? await inspectRoutineConfiguration(context.userId,input.workflow_id)
          : {workspaceId,proposals:await listRoutineProposals(context.userId,workspaceId)}
      if (value.workspaceId!==workspaceId) throw new RoutineConfigurationError('routine_not_found',404)
      return value
    }),
  })
  const proposeRoutineIntake = buildTool({name:'proposeRoutineIntake',requiresCapability:CONFIGURE_CAPABILITY,isReadOnly:false,
    description:'Save an inactive, exact routine proposal for human review. Pass configuration (native definition.taskIntake, defaultExecutor, event trigger and explicit context), rationale, expected_revision and idempotency_key. For a revision pass workflow_id. For a new routine pass name and authoring_assistant_id explicitly. Unknown configuration remains a draft; no routine or grant is activated. Support comes only from sources actually admitted in this turn.',
    inputSchema:z.object({workflow_id:z.string().uuid().optional(),name:z.string().min(1).max(120).optional(),
      authoring_assistant_id:z.string().uuid().optional(),configuration:routineProposalCommandSchema.shape.configuration,
      expected_revision:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(200),
      rationale:z.string().trim().min(1).max(4000),uncertainties:z.array(z.string().max(500)).max(40).default([])}).strict(),
    execute:(input,context)=>run(context,true,async workspaceId=>{
      const command = {configuration:input.configuration,expectedRevision:input.expected_revision,
        idempotencyKey:input.idempotency_key,rationale:input.rationale,uncertainties:input.uncertainties}
      const evidence = context.scopeAccumulator?.evidence ?? {}
      if (input.workflow_id) {
        if ((await inspectRoutineConfiguration(context.userId,input.workflow_id)).workspaceId!==workspaceId) throw new RoutineConfigurationError('routine_not_found',404)
        return prepareRoutineProposal(context.userId,input.workflow_id,command,evidence,provenanceSessionId(context) ?? undefined)
      }
      if (!input.name || !input.authoring_assistant_id) throw new RoutineConfigurationError('routine_configuration_invalid',400)
      return prepareNewRoutineProposal(context.userId,workspaceId,{...command,name:input.name,authoringAssistantId:input.authoring_assistant_id},evidence,provenanceSessionId(context) ?? undefined)
    }),
  })
  const decisionSchema = z.object({proposal_id:z.string().uuid(),expected_revision:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(200)}).strict()
  const applyRoutineIntake = buildTool({name:'applyRoutineIntake',requiresCapability:CONFIGURE_CAPABILITY,requiresConfirmation:true,
    description:'Apply the exact routine proposal a person has reviewed. Use its proposal_id and expected_revision plus an idempotency_key. Actual human confirmation is required; credentials and delegated/learned approvals cannot activate it. Read the exact proposal first. It creates no new allowance for an existing Task.',
    inputSchema:decisionSchema,execute:(input,context)=>run(context,true,async workspaceId=>{
      const actor=humanActor(context)
      if ((await inspectRoutineProposal(actor.userId,input.proposal_id)).workspaceId!==workspaceId) throw new RoutineConfigurationError('routine_not_found',404)
      return applyRoutineProposal(actor,input.proposal_id,{expectedRevision:input.expected_revision,idempotencyKey:input.idempotency_key})
    }),
  })
  const rejectRoutineIntake = buildTool({name:'rejectRoutineIntake',requiresCapability:CONFIGURE_CAPABILITY,requiresConfirmation:true,
    description:'Reject the exact inactive routine proposal after human review. Pass proposal_id, expected_revision and idempotency_key. This records the human decision and activates nothing.',
    inputSchema:decisionSchema,execute:(input,context)=>run(context,true,async workspaceId=>{
      const actor=humanActor(context)
      if ((await inspectRoutineProposal(actor.userId,input.proposal_id)).workspaceId!==workspaceId) throw new RoutineConfigurationError('routine_not_found',404)
      return rejectRoutineProposal(actor,input.proposal_id,{expectedRevision:input.expected_revision,idempotencyKey:input.idempotency_key})
    }),
  })
  const toggle = buildTool({name:'setRoutineIntakeEnabled',requiresCapability:CONFIGURE_CAPABILITY,requiresConfirmation:true,
    description:'Enable or disable future intake for an exactly reviewed routine revision. Actual human confirmation is required. Disable stops new intake only. Existing Tasks continue under current source/tool rights, explicit pauses and their original shared allowance. Re-enable does not replay intake, clear Task pauses or refresh budgets.',
    inputSchema:z.object({workflow_id:z.string().uuid(),enabled:z.boolean(),expected_revision:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(200)}).strict(),
    execute:(input,context)=>run(context,true,async workspaceId=>{
      const actor=humanActor(context)
      if ((await inspectRoutineConfiguration(actor.userId,input.workflow_id)).workspaceId!==workspaceId) throw new RoutineConfigurationError('routine_not_found',404)
      return setRoutineIntakeEnabled(actor,input.workflow_id,{enabled:input.enabled,expectedRevision:input.expected_revision,idempotencyKey:input.idempotency_key})
    }),
  })
  return {getRoutineIntake,proposeRoutineIntake,applyRoutineIntake,rejectRoutineIntake,setRoutineIntakeEnabled:toggle}
}
