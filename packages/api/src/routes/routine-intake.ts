/** Authenticated Workflow views/commands over native routine proposals.
 * [COMP:api/routine-proposals]
 */
import type { Request, Response, Router } from 'express'
import { z } from 'zod'
import { applyRoutineProposal, inspectRoutineConfiguration, inspectRoutineProposal, listRoutineProposals,
  prepareNewRoutineProposal, prepareRoutineProposal, rejectRoutineProposal, routineDecisionCommandSchema,
  routineProposalCommandSchema, RoutineConfigurationError, setRoutineIntakeEnabled } from '../tasks/routine-proposals.js'

const proposalBody = routineProposalCommandSchema.extend({ workflowId:z.string().uuid().optional(),
  workspaceId:z.string().uuid().optional(),name:z.string().min(1).max(120).optional(),authoringAssistantId:z.string().uuid().optional() }).strict()
const user = (req: Request) => {
  if (!req.userId) throw new RoutineConfigurationError('unauthorized',401)
  return req.userId
}
const human = (req: Request) => ({kind:'ui' as const,userId:user(req),authSessionId:req.authSessionId ?? ''})
function respond(res: Response, operation: () => Promise<unknown>) {
  res.setHeader('Cache-Control','private, no-store')
  return operation().then(value=>res.json(value)).catch(error=>{
    if (error instanceof RoutineConfigurationError) return res.status(error.status).json({error:error.code})
    if ((error as {reason?:string}).reason==='caller_evidence_unavailable') return res.status(404).json({error:'routine_not_found'})
    if ((error as {status?:number}).status===409 || (error as {reason?:string}).reason==='workflow_authority_unavailable') {
      return res.status(409).json({error:'routine_authoring_unavailable'})
    }
    throw error
  })
}

/** Mount before the generic /workflows/:id routes. */
export function mountRoutineIntakeRoutes(router: Router): void {
  router.get('/workflows/intake-proposals',(req,res)=>respond(res,async()=>{
    const workspace = z.string().uuid().safeParse(req.query.workspaceId)
    const workflow = z.string().uuid().optional().safeParse(req.query.workflowId)
    const session = z.string().uuid().optional().safeParse(req.query.sessionId)
    if (!workspace.success || !workflow.success || !session.success) throw new RoutineConfigurationError('routine_configuration_invalid',400)
    return {proposals:await listRoutineProposals(user(req),workspace.data,workflow.data,session.data)}
  }))
  router.post('/workflows/intake-proposals',(req,res)=>respond(res,async()=>{
    const parsed=proposalBody.safeParse(req.body)
    if (!parsed.success) throw new RoutineConfigurationError('routine_configuration_invalid',400)
    const {workflowId,workspaceId,name,authoringAssistantId,...command}=parsed.data
    if (workflowId) {
      if (workspaceId && (await inspectRoutineConfiguration(user(req),workflowId)).workspaceId!==workspaceId) throw new RoutineConfigurationError('routine_not_found',404)
      return prepareRoutineProposal(user(req),workflowId,command)
    }
    if (!workspaceId || !name || !authoringAssistantId) throw new RoutineConfigurationError('routine_configuration_invalid',400)
    return prepareNewRoutineProposal(user(req),workspaceId,{...command,name,authoringAssistantId})
  }))
  router.get('/workflows/intake-proposals/:proposalId',(req,res)=>respond(res,()=>inspectRoutineProposal(user(req),String(req.params.proposalId))))
  for (const decision of ['apply','reject'] as const) router.post(`/workflows/intake-proposals/:proposalId/${decision}`,(req,res)=>respond(res,async()=>{
    const body=routineDecisionCommandSchema.safeParse(req.body)
    if (!body.success) throw new RoutineConfigurationError('routine_configuration_invalid',400)
    const actor=human(req)
    if (!actor.authSessionId) throw new RoutineConfigurationError('routine_human_apply_required',403)
    return decision==='apply' ? applyRoutineProposal(actor,String(req.params.proposalId),body.data)
      : rejectRoutineProposal(actor,String(req.params.proposalId),body.data)
  }))
  router.patch('/workflows/:id/intake',(req,res)=>respond(res,async()=>{
    const body=routineDecisionCommandSchema.extend({enabled:z.boolean()}).safeParse(req.body)
    if (!body.success) throw new RoutineConfigurationError('routine_configuration_invalid',400)
    return setRoutineIntakeEnabled(human(req),String(req.params.id),body.data)
  }))
  router.get('/workflows/:id/intake',(req,res)=>respond(res,()=>inspectRoutineConfiguration(user(req),String(req.params.id))))
}
