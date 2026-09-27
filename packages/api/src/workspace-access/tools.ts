import {explainWorkspaceAccess,getWorkspaceAccessEvents} from './access-inspection.js'
import {workspaceAccessExplanationQuerySchema} from './commands.js'
import {prepareOrganizationCommand,applyOrganizationCommandIntent} from './organization-command-review.js'
import { z } from 'zod'
import { buildTool, type ToolContext, type Tool } from '@use-brian/core'
import { getOrganizationChart, OrganizationError } from '../db/org-chart-store.js'
import { departmentAccessRequestSchema, departmentCommandIntentSchema, organizationCommandIntentSchema } from './commands.js'

import { getWorkspaceAccess, getWorkspaceAccessHistory, getWorkspaceAccessRequest } from './service.js'
import {prepareDepartmentCommand,applyDepartmentCommandIntent} from './command-review.js'
import { WorkspaceAccessError } from './policy.js'
import { executeWorkspaceScopeReview, getWorkspaceScopeInventory, getWorkspaceScopeReview, scopeReviewCommandSchema } from './scope-review.js'

function actor(context: ToolContext): {workspaceId:string;userId:string} {
  if (!context.workspaceId || !context.workspaceActorUserId || context.systemRead || context.programmaticPrincipal) {
    throw new OrganizationError('admin_required',403)
  }
  return {workspaceId:context.workspaceId,userId:context.workspaceActorUserId}
}
function failure(error:unknown) {
  const code=error instanceof OrganizationError||error instanceof WorkspaceAccessError?error.code:'workspace_access_unavailable'
  const recovery=code==='scope_review_impact_too_large'?'The selection affects more than 500 known derived memories. Select fewer source records and create a new preview. This attempt applied no classifications. Earlier pages stay applied.'
    :code==='scope_review_impact_missing'?'This saved review predates impact evidence. Inspect current inventory and create a new preview before applying. The old review remains inspectable and cancellable.':null
  return {isError:true,data:{error:code,...(recovery?{message:recovery,retrySafe:false}:{})}}
}
/** Native and UI changes share commands, current membership checks and audit. */
export function createOrganizationTools(): Tool[] {
  return [buildTool({
    name:'getOrganizationChart',
    description:'View the current workspace organization: visible units, people, reporting lines, assistants and accountable humans. This directory does not grant content access. Requires a verified human in the current conversation. Hidden units and identities are omitted.',
    inputSchema:z.object({}).strict(),isReadOnly:true,isConcurrencySafe:true,
    async execute(_input,context){try{const principal=actor(context);return{data:await getOrganizationChart(principal.workspaceId,principal.userId)}}catch(error){return failure(error)}},
  }),buildTool({
    name:'updateOrganizationChart',
    description:'Create, rename, move or archive an organization unit, or set/remove a person or assistant placement. Requires the current verified human to be a workspace owner/admin and an explicit confirmation. Provide {command, expectedRevision, expectedPolicyRevision, idempotencyKey} using the current chart revision, initialization.policyRevision and a UUID key. Keep that exact intent for retries. Use current chart IDs and expectedVersion in the command. org.initialize.subject uses the admin chart initialization candidates: explicitly select a direct Team assignment and supply expectedRevision plus expectedPolicyRevision. It creates a members-only root unit if needed and a primary placement atomically; it never guesses reporting/accountability or changes access. Reporting/placement never changes data permissions. Archive requires an explicit destination, with null meaning unassigned placements and root-level children.',
    inputSchema:organizationCommandIntentSchema,isReadOnly:false,isConcurrencySafe:false,requiresConfirmation:true,allowPersistentApproval:false,
    async describeConfirmation(input,context){
      const principal=actor(context)
      const review=await prepareOrganizationCommand(principal.workspaceId,principal.userId,input)
      if(review.alreadyApplied)return ['This exact organization change was already applied. Continuing only retrieves your current visible chart; it does not repeat the change.']
      return [review.command.type,...review.effects.flatMap(effect=>[`${effect.kind}: ${effect.name}`, ...effect.changes.map(change=>`${change.field}: ${change.before.map(value=>value.value).join(', ')} → ${change.after.map(value=>value.value).join(', ')}`)]),`Review expires: ${review.expiresAt}`,'Organization and directory only. Department memberships, clearance and content access are unchanged.']
    },
    async execute(input,context){try{const principal=actor(context);return{data:await applyOrganizationCommandIntent(principal.workspaceId,principal.userId,input)}}catch(error){return failure(error)}},
  })]
}

/** Attended human operations only. A tool cannot choose its acting principal. */
export function createWorkspaceAccessTools(): Tool[] {
  const describe = async(input:unknown,context:ToolContext) => {
    const principal=actor(context)
    const intent=departmentCommandIntentSchema.parse(input),command=intent.command
    const review=await prepareDepartmentCommand(principal.workspaceId,principal.userId,intent)
    if(review.alreadyApplied)return ['This exact change was already applied. Continuing only retrieves your current access; it does not repeat the change.']
    const view=await getWorkspaceAccess(principal.workspaceId,principal.userId)
    const names=new Map([...view.teams,...view.people].map(row=>[row.id,row.name]))
    const lines=[command.type,...Object.entries(command).filter(([key])=>key!=='type').map(([key,value])=>`${key}: ${typeof value==='string'?(names.get(value)??value):JSON.stringify(value)}`)]
    if(command.type==='access.request.decide') {
      const selected=await getWorkspaceAccessRequest(principal.workspaceId,principal.userId,command.requestId)
      const request=selected.request
      if(!request?.canDecide)throw new WorkspaceAccessError('department_approver_required')
      if(command.policyRevision!==view.policyRevision||command.policyRevision!==selected.policyRevision||command.payloadHash!==request.payloadHash||command.expectedVersion!==request.version)throw new WorkspaceAccessError('request_review_stale',409)
      lines.push(request.targetTeamName,request.beneficiaryName??request.beneficiaryId,request.reason,`Starts: ${request.startsAt}`,`Expires: ${request.expiresAt??'ongoing'}`)
    }
    if(command.type==='member.access.set') {
      if(!view.canAdminister)throw new WorkspaceAccessError('admin_required')
      const person=view.people.find(row=>row.id===command.userId)
      if(!person?.access)throw new WorkspaceAccessError('not_found',404)
      if(person.role!=='member')throw new WorkspaceAccessError('member_role_required',409)
      if(command.expectedPolicyRevision!==view.policyRevision)throw new WorkspaceAccessError('access_policy_conflict',409)
      lines.push(`Clearance: ${person.access.clearance} → ${command.clearance}.`, `Department mode: ${person.access.teamScopeMode} → ${command.teamScopeMode}.`,
        'Assigned mode uses current department membership packages and separate read grants. Legacy mode preserves the previous direct scope, which can include all departments. Clearance, visibility, Project and assistant restrictions still apply. Roles, memberships and reporting lines are unchanged.')
    }
    if(command.type==='department.member.set')lines.push(command.activateAssigned?'Explicitly switch this member to assigned Team mode. Requires complete departmental readiness.':'Preserve this member’s existing access mode.')
    if(command.type==='department.read_bundle.set')lines.push('This changes an ordinary membership package, including its existing mutation reach. It is not a temporary read-only grant.')
    lines.push('Read grants never add editing rights, clearance, assistant access or the target department’s other access packages. Team beneficiaries include current and future direct human members. Management responsibility alone grants no content access.')
    lines.push(...review.changes.map(change=>`${change.field.replaceAll('_',' ')}: ${change.before.map(value=>value.value).join(', ')} → ${change.after.map(value=>value.value).join(', ')}`),`Review expires: ${review.expiresAt}`)
    return lines
  }
  const execute=async(input:unknown,context:ToolContext)=>{try{const p=actor(context);return{data:await applyDepartmentCommandIntent(p.workspaceId,p.userId,input)}}catch(error){return failure(error)}}
  return [buildTool({
    name:'inspectWorkspaceAccess',description:'Inspect visible departments, your access requests and read-only grants, and your current authority to manage memberships or approve requests. For current human/assistant/context read-versus-edit explanations and independent grant paths, pass explain. The running conversation ceiling also bounds the final explanation; independent human grant paths cannot widen it. Matching scope still requires resource-specific authorization. Inspect content-free audit with history events. For older records, pass history (requests, grants or events), after (the returned next cursor), and expectedPolicyRevision. Omit after and revision to restart that history. Returns departmental readiness, current policy revision and immutable request version/hash for a fresh review. Requires the verified human in this conversation; never uses an assistant owner as a substitute.',
    inputSchema:z.object({explain:workspaceAccessExplanationQuerySchema.optional(),history:z.enum(['requests','grants','events']).optional(),after:z.string().uuid().optional(),expectedPolicyRevision:z.string().regex(/^[1-9][0-9]*$/).optional()}).strict().refine(value=>Boolean(value.after)===Boolean(value.expectedPolicyRevision)&&(!value.after||Boolean(value.history))&&(!value.explain||(!value.history&&!value.after))),isReadOnly:true,isConcurrencySafe:true,
    async execute(input,context){try{const p=actor(context);return{data:input.explain?await explainWorkspaceAccess(p.workspaceId,p.userId,input.explain):input.history==='events'?await getWorkspaceAccessEvents(p.workspaceId,p.userId,{after:input.after,expectedPolicyRevision:input.expectedPolicyRevision}):input.history?await getWorkspaceAccessHistory(p.workspaceId,p.userId,input.history,{after:input.after,expectedPolicyRevision:input.expectedPolicyRevision}):await getWorkspaceAccess(p.workspaceId,p.userId)}}catch(error){return failure(error)}},
  }),buildTool({
    name:'requestWorkspaceAccess',description:'Submit a read-only request for a visible requestable department. Members request for themselves; administrators may name another person or a Team. Provide an intent with command, a fresh expectedPolicyRevision and a UUID idempotencyKey. Keep that exact intent for retries. Defaults should be 30 days. An independent current approver must approve before access changes. Use inspectWorkspaceAccess for available IDs and readiness. An incomplete release refuses new delegation.',
    inputSchema:departmentCommandIntentSchema.extend({command:departmentAccessRequestSchema}),isReadOnly:false,isConcurrencySafe:false,requiresConfirmation:true,allowPersistentApproval:false,describeConfirmation:describe,execute,
  }),buildTool({
    name:'manageWorkspaceAccess',description:'Create, update or archive departments, edit their flat read packages and assistant audiences, and manage member clearance and Team mode, directory settings, manager responsibilities, ordinary memberships, requests and revocations through the same commands as Settings > Department access. Use inspectWorkspaceAccess first. Provide command, expectedPolicyRevision and a UUID idempotencyKey; preserve that exact intent on retry. The confirmation prepares a saved review and execution only consumes it. New delegation requires ready enforcement; reductions and revocations remain available. Current authority is rechecked transactionally; reporting hierarchy does not confer permission, expanded membership packages require an administrator, and self-approval is forbidden. Decisions require the reviewed policy revision, request version and payload hash.',
    inputSchema:departmentCommandIntentSchema,isReadOnly:false,isConcurrencySafe:false,requiresConfirmation:true,allowPersistentApproval:false,describeConfirmation:describe,execute,
  }),buildTool({
    name:'inspectScopeReview',description:'Administrator-only metadata inventory and saved classification previews. General means no Team requirement; clearance and private visibility still apply. Coverage is incomplete and cannot certify strict isolation. Inspect a selected review by its ID to resume it. Pass nextReviewCursor as reviewAfter for older saved reviews, or omit it for the latest page. Never returns document bodies.',
    inputSchema:z.object({kind:z.enum(['memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk']).default('memory'),after:z.string().uuid().optional(),reviewId:z.string().uuid().optional(),reviewAfter:z.string().uuid().optional()}).strict(),isReadOnly:true,isConcurrencySafe:true,
    async execute(input,context){try{const p=actor(context);return{data:await getWorkspaceScopeInventory(p.workspaceId,p.userId,input.kind,input.after,input.reviewId,input.reviewAfter)}}catch(error){return failure(error)}},
  }),buildTool({
    name:'manageScopeReview',description:'Preview, apply up to 25 items, or cancel a saved administrator classification review. Use inspectScopeReview first. Select at most 100 explicit resource IDs affecting at most 500 known derived memories. The saved preview includes immutable impact references, not bodies; changed dependencies require a new preview. Actions confirm General, assign a Team to unheld General records, or hold records and known descendants. Never releases a hold. Each apply needs the saved review version and payload hash; retrying an older version returns progress without applying another page. Cancelling preserves previously applied changes. Does not activate strict isolation.',
    inputSchema:scopeReviewCommandSchema,isReadOnly:false,isConcurrencySafe:false,requiresConfirmation:true,allowPersistentApproval:false,
    async describeConfirmation(input,context){
      const p=actor(context),command=scopeReviewCommandSchema.parse(input)
      if(command.type==='scope.review.preview'){
        const access=await getWorkspaceAccess(p.workspaceId,p.userId)
        if(!access.canAdminister)throw new WorkspaceAccessError('admin_required')
        return [command.type,command.action,command.resourceKind,...command.resourceIds,command.reason,command.targetTeamId??'General / hold','Creates a preview only. No content classification changes.']
      }
      const review=await getWorkspaceScopeReview(p.workspaceId,p.userId,command.reviewId)
      if(review.version!==command.expectedVersion||review.payloadHash!==command.payloadHash)throw new WorkspaceAccessError('scope_review_changed',409)
      if(command.type==='scope.review.apply'&&review.items.some(item=>!item.impact))throw new WorkspaceAccessError('scope_review_impact_missing',409)
      const impact=[...new Map(review.items.flatMap(item=>item.impact?.descendants??[]).map(row=>[row.resourceId,row])).values()]
      return [command.type,review.action,review.resourceKind,review.targetCompartment??'General / hold',review.reason,...review.items.filter(item=>item.status==='pending').slice(0,25).map(item=>JSON.stringify({id:item.resourceId,source:item.source})),
        ...(command.type==='scope.review.apply'?[`Known affected memories in this saved review: ${impact.length}; already held at preview: ${impact.filter(row=>row.held).length}.`,...impact.map(row=>JSON.stringify(row))]:[]),
        'Clearance, private visibility and Project labels are preserved. Known descendants can be held. Coverage is incomplete. Previously applied items are never rolled back.']
    },
    async execute(input,context){try{const p=actor(context);return{data:await executeWorkspaceScopeReview(p.workspaceId,p.userId,input)}}catch(error){return failure(error)}},
  })]
}
