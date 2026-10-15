/** Bounded contextual suggestions over Tasks actually read in this interaction.
 * No discovery query, timer, model call or execution grant.
 * [COMP:api/routine-proposals]
 */
import { createHash } from 'node:crypto'
import { CONFIGURE_CAPABILITY, provenanceSessionId, ContextScopeAccumulator, normalizeTaskTitle, scopeEvidenceFromRows,
  type AccessContext, type TaskListRow, type ToolContext } from '@use-brian/core'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { getTaskById } from '../db/tasks.js'
import { listRoutineProposals, prepareNewRoutineProposal, RoutineConfigurationError } from './routine-proposals.js'

// Dates and numbered occurrences can vary; the actual action and target stay
// intact. This deliberately misses semantic paraphrases rather than guessing.
function pattern(title: string): string {
  return normalizeTaskTitle(title.replace(/\b\d{4}-\d{2}-\d{2}\b/g,'').replace(/\s+#\d+\s*$/u,''))
}

export async function observeRoutineTasks(rows: readonly TaskListRow[], access: AccessContext, context: ToolContext) {
  const empty = {proposals:[] as {id:string;workflowId:string;status:string}[]}
  if (!context.workspaceId || context.programmaticPrincipal || !rows.length
    || !(await createDbCapabilityStore().listActive(context.assistantId)).includes(CONFIGURE_CAPABILITY)) return empty
  const observed = new Map(rows.map(row=>[row.id,row]))
  // The existing turn accumulator is the observation boundary. Re-read only
  // those exact ids under current native access; superseded/revoked rows drop.
  for (const source of (context.scopeAccumulator?.evidence.sources ?? []).slice(-40)) {
    if (source.resourceKind!=='task' || source.workspaceId!==context.workspaceId || observed.has(source.resourceId)) continue
    const task=await getTaskById(access,source.resourceId)
    if (task) observed.set(task.id,task)
  }
  const groups=new Map<string,TaskListRow[]>()
  for (const row of observed.values()) {
    if (row.parentId || !row.home || !(row.executorAssistantId || row.assigneeId) || row.status==='archived') continue
    const title=pattern(row.title)
    if (title.length<12) continue
    const key=JSON.stringify([title,row.home,row.executorAssistantId ?? null,row.assigneeId])
    const group=groups.get(key) ?? []
    group.push(row); groups.set(key,group)
  }
  const evidence=new ContextScopeAccumulator()
  const proposals:typeof empty.proposals=[]
  try {
    const pending=await listRoutineProposals(context.userId,context.workspaceId)
    for (const [key,support] of groups) {
      // A conservative suggestion default, never an activation/approval rule.
      if (support.length<3 || proposals.length>=2) continue
      const idempotencyKey=`contextual:${createHash('sha256').update(key).digest('hex')}`
      let proposal=pending.find(p=>p.arguments.idempotencyKey===idempotencyKey)
      if (!proposal) {
        const first=support[0], home=first.home!
        const title=pattern(first.title)
        const sourceEvidence=scopeEvidenceFromRows(support)
        proposal=await prepareNewRoutineProposal(context.userId,context.workspaceId,{
          name:first.title.slice(0,120),authoringAssistantId:context.assistantId,expectedRevision:0,idempotencyKey,
          rationale:'Several admitted Tasks in this interaction repeat the same action, executor and operating home.',
          uncertainties:['Review the trigger match, outcome, completion check and required actions/accounts before applying.'],
          configuration:{contextGroupId:home.kind==='department'?home.id:null,contextProjectId:home.kind==='project'?home.id:null,
            trigger:{kind:'event',event:{sources:[{source:{type:'task'},match:{inChannels:['created'],keywords:[title]}}]}},
            definition:{startStepId:'intake',steps:[{id:'intake',type:'branch',condition:{'==':[1,1]},nextStepIdIfTrue:null,nextStepIdIfFalse:null}],
              defaultExecutor:first.executorAssistantId?{kind:'assistant',assistantId:first.executorAssistantId}:{kind:'person',memberId:first.assigneeId!},
              taskIntake:{version:1,home,blueprint:{outcome:title,description:'Repeat the reviewed work for the admitted source Task.',
                completionCheck:'The reviewed outcome for the source Task is complete.',inputs:[{key:'sourceTask',label:'Source Task',path:'event.taskId',required:true}]},
                permittedActions:[],requiredAccounts:[]}}},
        },sourceEvidence,provenanceSessionId(context) ?? undefined)
      }
      evidence.note(proposal.arguments.sourceEvidence)
      proposals.push({id:proposal.id,workflowId:proposal.arguments.workflowId,status:proposal.status})
    }
  } catch (error) {
    // Old/unready installations retain native Task reads without enabling intake.
    if ((error as Error).message==='routine_schema_not_ready' || error instanceof RoutineConfigurationError
      && ['routine_authoring_unavailable','routine_not_found','routine_idempotency_conflict'].includes(error.code)) return empty
    throw error
  }
  return {proposals,scopeEvidence:evidence.evidence}
}
