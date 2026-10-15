/** Shared Brian/Brain-MCP adapters. Spec: client-delivery-oversight.md.
 * [COMP:crm/delivery-oversight]
 */
import { z } from 'zod'
import { CrmOperationsError } from './operations-types.js'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext, crmOperationsToolFailure } from './operations-tools.js'
import type { CrmOperationsServicePort } from './operations-types.js'
import { AppendDeliveryObservationSchema, DeliveryProposalSchema, DeliveryListQuerySchema, RecordDeliveryRecognitionSchema,
  RefreshDeliveryAssessmentSchema, ReviewDeliveryRecognitionSchema, WithdrawDeliveryObservationSchema,
  type DeliveryCommand, type DeliveryReadPort, type DeliveryViewer } from './delivery-oversight.js'

export type CrmDeliveryOversightTools = Record<'listCrmDeliveryCommitments'|'getCrmDeliveryAssessment'|'refreshCrmDeliveryAssessment'|
 'recordCrmDeliveryRecognition'|'reviewCrmDeliveryRecognition'|'appendCrmDeliveryObservation'|'withdrawCrmDeliveryObservation',Tool>
export function createCrmDeliveryOversightTools(options:{reads:DeliveryReadPort;service:CrmOperationsServicePort}):CrmDeliveryOversightTools {
  const viewer=(ctx:ToolContext):DeliveryViewer=>({userId:ctx.userId,
    ...(!ctx.programmaticPrincipal && z.string().uuid().safeParse(ctx.sessionId).success?{chatId:ctx.sessionId}:{})})
  function tool(name:keyof CrmDeliveryOversightTools,description:string,schema:z.ZodTypeAny,isReadOnly:boolean,
    run:(input:Record<string,unknown>,ctx:ToolContext)=>Promise<unknown>):Tool {
    const built:Tool = buildTool({name,description,inputSchema:schema,isReadOnly,requiresCapability:'crm',homeAppToolSet:{app:'crm',set:isReadOnly?'read':'write'},
      ...(name==='reviewCrmDeliveryRecognition'?{requiresConfirmation:true,confirmationMode:'durable_attended' as const,allowPersistentApproval:false}:{}),
      async execute(input,ctx){
        if(!ctx.workspaceId||!ctx.userId)return {isError:true,data:{error:'not_authorized',message:'Current workspace and source authority are required.'}}
        const missing=missingToolCapability(built,ctx.activeCapabilities);if(missing)return {isError:true,data:{error:'not_authorized',requiredCapability:missing}}
        try{return {data:await run(schema.parse(input),ctx)}}catch(error){return crmOperationsToolFailure(error)}
      }})
    return built
  }
  const command=(input:Record<string,unknown>,ctx:ToolContext,kind:DeliveryCommand['kind'])=>{
    const context=crmOperationsToolContext(ctx)
    if(!context)throw new Error('Current workspace authority is unavailable')
    context.authority.deliveryCredentialParent=ctx.crmCredentialParent
    if(kind==='review_delivery_recognition'&&ctx.approvedToolInvocation?.toolName==='reviewCrmDeliveryRecognition') {
      context.authority.deliveryReviewApproval={...ctx.approvedToolInvocation,toolName:'reviewCrmDeliveryRecognition'}
    }
    return options.service.execute(context,{...input,kind} as DeliveryCommand)
  }
  return {
    listCrmDeliveryCommitments:tool('listCrmDeliveryCommitments','List existing client commitments in the admitted personal, Project or Department scope, up to 50 per page. Missing updates are unknown, never failure.',DeliveryListQuerySchema.innerType(),true,
      (input,ctx)=>options.reads.list(viewer(ctx),ctx.workspaceId!,DeliveryListQuerySchema.parse(input))),
    getCrmDeliveryAssessment:tool('getCrmDeliveryAssessment','Inspect admitted agreement evidence, dated reports, coverage gaps and at most one grounded issue/action. Task closure does not verify client delivery. No research, work or messages are started.',
      z.object({commitmentId:z.string().uuid()}).strict(),true,async(input,ctx)=>{const row=await options.reads.get(viewer(ctx),ctx.workspaceId!,input.commitmentId as string);if(!row)throw new CrmOperationsError('not_found','The record is unavailable in your current scope.');return row}),
    refreshCrmDeliveryAssessment:tool('refreshCrmDeliveryAssessment','Explicitly refresh this existing commitment using current admitted evidence only. Reuse the operationId on uncertain outcomes. No chasing, recipient selection, research or work execution.',RefreshDeliveryAssessmentSchema.omit({kind:true}),false,
      (input,ctx)=>command(input,ctx,'refresh_delivery_assessment')),
    recordCrmDeliveryRecognition:tool('recordCrmDeliveryRecognition','Record an agreement that already exists, with an exact native source id/revision/quote/selector and actual agreeing actor basis. Ambiguity stays needs_review. This cannot create a client, promise, Task or terms.',z.object({operationId:z.string().uuid(),proposal:DeliveryProposalSchema.extend({source:DeliveryProposalSchema.shape.source.optional()}),quote:z.string().min(1).max(2000).optional()}).strict(),false,
      async(input,ctx)=>{
        const normalized=z.union([RecordDeliveryRecognitionSchema.omit({kind:true}),z.object({operationId:z.string().uuid(),proposal:DeliveryProposalSchema.omit({source:true}),quote:z.string().min(1).max(2000)}).strict()]).parse(input)
        input=normalized
        const proposal=input.proposal as Record<string,unknown>
        if(!proposal.source) {
          if(!ctx.userMessageText||ctx.programmaticPrincipal||!options.reads.locateChatSource)throw new Error('Supply exact native source identity or use the current authenticated Chat input.')
          const source=await options.reads.locateChatSource(viewer(ctx),ctx.workspaceId!,ctx.sessionId,input.quote as string,ctx.userMessageText)
          if(!source)throw new Error('The current exact Chat input is unavailable. Stop instead of scanning or retrying.')
          return command({operationId:input.operationId,proposal:{...proposal,source}},ctx,'record_delivery_recognition')
        }
        return command(input,ctx,'record_delivery_recognition')
      }),
    appendCrmDeliveryObservation:tool('appendCrmDeliveryObservation','Append one exact admitted source observation/report to an existing commitment. statement must equal the quote; dates, absent updates, Task closure and assistant replies cannot establish a delivery issue or verified outcome.',AppendDeliveryObservationSchema.omit({kind:true}),false,
      (input,ctx)=>command(input,ctx,'append_delivery_observation')),
    withdrawCrmDeliveryObservation:tool('withdrawCrmDeliveryObservation','Withdraw an existing source observation with expected version and reason. Reuse the operationId on uncertain results. No original source or CRM terms are rewritten.',WithdrawDeliveryObservationSchema.omit({kind:true}),false,
      (input,ctx)=>command(input,ctx,'withdraw_delivery_observation')),
    reviewCrmDeliveryRecognition:tool('reviewCrmDeliveryRecognition','Human review of existing agreement evidence: recognise, correct its interpretation or dismiss. Requires an exact attended persisted human approval, current source authority and expected version. A machine credential or workflow grant cannot review on behalf of a human.',ReviewDeliveryRecognitionSchema.innerType().omit({kind:true}),false,
      (input,ctx)=>command(input,ctx,'review_delivery_recognition')),
  }
}
