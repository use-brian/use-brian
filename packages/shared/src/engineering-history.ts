/** Versioned engineering archive wire contracts. [COMP:shared/engineering-history] */
import {z} from 'zod'
export const CaptureConfigurationSchema=z.object({
 connectionId:z.string().min(1),contractVersion:z.literal(1),processingPurpose:z.enum(['extract','archive_only']).nullable(),ready:z.boolean(),
 failureCode:z.string().optional(),profileId:z.string().uuid().optional(),profileRevision:z.string().optional(),
 permittedEventKinds:z.array(z.enum(['user','assistant'])),
 audience:z.array(z.object({kind:z.enum(['department','project']),id:z.string(),label:z.string()})),
 limits:z.object({maxEventBytes:z.number().int().positive(),maxExportEvents:z.number().int().positive()}),
 receiptContractVersion:z.literal(1),localEmitterObserved:z.literal(false),
})
export type CaptureConfiguration=z.infer<typeof CaptureConfigurationSchema>
export const EngineeringCaptureReceiptSchema=z.object({
 contractVersion:z.literal(1),processingPurpose:z.literal('archive_only'),
 outcome:z.enum(['queued','archived','duplicate','dropped']),receiptStatus:z.enum(['processing','queued','completed','dropped','failed']),
 archiveId:z.string().uuid().optional(),fileId:z.string().uuid().optional(),
 deliveryStatus:z.enum(['pending','archived','excluded','deleted','dropped','held']),indexStatus:z.enum(['pending','ready','withheld']),
 profileId:z.string().uuid().optional(),profileRevision:z.string().optional(),ruleId:z.string().uuid().optional(),
 failureCode:z.string().optional(),firesAt:z.string().datetime({offset:true}).optional(),
}).superRefine((r,ctx)=>{
 const valid=r.deliveryStatus==='archived'?r.receiptStatus==='completed'&&r.indexStatus==='ready'&&!!r.fileId&&!!r.archiveId&&['archived','duplicate'].includes(r.outcome)
  :r.deliveryStatus==='pending'?['queued','processing'].includes(r.receiptStatus)&&r.indexStatus==='pending'
  :r.deliveryStatus==='held'?r.receiptStatus==='queued'&&r.indexStatus==='withheld'
  :r.deliveryStatus==='dropped'?r.receiptStatus==='dropped'&&r.indexStatus==='withheld'
  :r.receiptStatus==='completed'&&r.indexStatus==='withheld'&&!!r.archiveId;
 if(!valid)ctx.addIssue({code:'custom',message:'Inconsistent engineering receipt state'})
})
export type EngineeringCaptureReceipt=z.infer<typeof EngineeringCaptureReceiptSchema>
export const EngineeringHistoryQuerySchema=z.object({
 query:z.string().max(500).optional(),cursor:z.string().max(2000).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),
 provider:z.string().max(40).optional(),sessionId:z.string().max(200).optional(),profileId:z.string().uuid().optional(),keyId:z.string().uuid().optional(),
 since:z.string().datetime({offset:true}).optional(),until:z.string().datetime({offset:true}).optional(),
}).strict()
export type EngineeringHistoryQuery=z.infer<typeof EngineeringHistoryQuerySchema>
export const EngineeringHistoryCommandSchema=z.object({
 action:z.enum(['list','search','read','export','annotate','exclude','delete']),eventId:z.string().uuid().optional(),
 query:EngineeringHistoryQuerySchema.optional(),text:z.string().min(1).max(4000).optional(),
 expectedRevision:z.number().int().positive().optional(),expectedFileVersion:z.string().regex(/^\d+$/).optional(),idempotencyKey:z.string().uuid().optional(),
}).strict()
export type EngineeringHistoryCommand=z.infer<typeof EngineeringHistoryCommandSchema>
